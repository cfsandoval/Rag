/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, ChangeEvent } from "react";
import { 
  FileText, 
  Search, 
  Plus, 
  Cpu, 
  Database, 
  Activity, 
  Zap,
  Loader2,
  Trash2,
  CheckCircle2
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";
import { getEmbedding, generateRAGResponse } from "./lib/gemini";
import { chunkText, searchChunks } from "./lib/vectorStore";
import { DocumentSource, Chunk, QueryResult, LogEntry } from "./types";
import { initAuth, loginWithGoogle } from "./lib/firebase";
import { 
  saveDocument, 
  saveChunks, 
  getDocuments, 
  getChunks, 
  deleteDocumentAndChunks,
  updateDocumentStatus,
  testConnection 
} from "./lib/db";
import { auth as firebaseAuth } from "./lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import * as pdfjs from "pdfjs-dist";

// PDFjs Worker setup
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const EXAMPLE_QUERIES = [
  "Haz un resumen ejecutivo de estos documentos",
  "¿Cuáles son los puntos clave discutidos?",
  "Encuentra discrepancias o riesgos potenciales",
  "Explica los conceptos más técnicos encontrados"
];

export default function App() {
  const [documents, setDocuments] = useState<DocumentSource[]>([]);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [query, setQuery] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isQuerying, setIsQuerying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [showPipeline, setShowPipeline] = useState(false);
  const [activeTab, setActiveTab] = useState<'documents' | 'query' | 'logs'>('documents');
  const [processLogs, setProcessLogs] = useState<LogEntry[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [viewMode, setViewMode] = useState<'terminal' | 'fragments'>('terminal');
  const [fragmentFilter, setFragmentFilter] = useState<string>('all');

  const addLog = (message: string, type: LogEntry['type'] = 'info', details?: string) => {
    const newLog: LogEntry = {
      timestamp: new Date().toLocaleTimeString(),
      message,
      type,
      details
    };
    setProcessLogs(prev => [newLog, ...prev].slice(0, 50));
  };

  const loadData = async () => {
    try {
      const [docs, fetchedChunks] = await Promise.all([
        getDocuments(),
        getChunks()
      ]);
      setDocuments(docs);
      setChunks(fetchedChunks);
    } catch (error) {
      console.error("Error loading data:", error);
    }
  };

  // Initialize Auth and Load Data
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
      if (user) {
        setIsAuthenticated(true);
        loadData();
      } else {
        setIsAuthenticated(false);
      }
    });

    const init = async () => {
      try {
        await initAuth();
        await testConnection();
        // onAuthStateChanged will trigger loadData
      } catch (error: unknown) {
        console.error("Initialization error:", error);
        const firebaseError = error as { code?: string; message?: string };
        if (firebaseError.code === 'auth/admin-restricted-operation') {
          setAuthError("La operación está restringida. Por favor inicia sesión con Google.");
        } else {
          setAuthError(firebaseError.message || "Error al inicializar sesión");
        }
      } finally {
        setIsLoading(false);
      }
    };
    init();

    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    setAuthError(null);
    try {
      await loginWithGoogle();
    } catch (error: unknown) {
      const firebaseError = error as { message?: string };
      setAuthError(firebaseError.message || "Error al iniciar sesión con Google");
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Statistics for the UI
  const totalChunks = documents.reduce((acc, doc) => acc + doc.chunkCount, 0);
  const usedSpace = (documents.reduce((acc, doc) => acc + doc.size, 0) / (1024 * 1024)).toFixed(2);

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    setIsProcessing(true);
    addLog(`Iniciando procesamiento de ${files.length} archivos`, 'info');
    
    for (const file of Array.from(files as FileList)) {
      try {
        addLog(`Procesando archivo: ${file.name}`, 'process');
        const id = Math.random().toString(36).substring(7);
        const newDoc: DocumentSource = {
          id,
          name: file.name,
          size: file.size,
          type: file.type,
          status: 'processing',
          chunkCount: 0
        };

        setDocuments(prev => [...prev, newDoc]);
        await saveDocument(newDoc);
        addLog(`Metadata guardada en Firestore: ${file.name}`, 'success');

        let text = "";
        addLog(`Extrayendo texto de ${file.name}...`, 'info');
        if (file.type === "application/pdf") {
          const arrayBuffer = await file.arrayBuffer();
          const pdf = await pdfjs.getDocument(arrayBuffer).promise;
          addLog(`PDF cargado: ${pdf.numPages} páginas encontradas`, 'info');
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map((item: unknown) => {
              const textItem = item as { str?: string };
              return textItem.str || '';
            }).join(" ") + " ";
          }
        } else {
          text = await file.text();
        }
        addLog(`Texto extraído exitosamente (${text.length} caracteres)`, 'success');

        addLog(`Dividiendo texto en fragmentos (chunking)...`, 'info');
        const textChunks = chunkText(text);
        addLog(`${textChunks.length} fragmentos generados`, 'info');
        
        const processedChunks: Chunk[] = [];

        for (const [index, chunkTextContent] of textChunks.entries()) {
          addLog(`Generando embedding para fragmento ${index + 1}/${textChunks.length}...`, 'process');
          const embedding = await getEmbedding(chunkTextContent);
          processedChunks.push({
            id: `${id}-${index}`,
            sourceId: id,
            sourceName: file.name,
            text: chunkTextContent,
            embedding,
            index
          });
        }
        addLog(`Embeddings generados exitosamente`, 'success');

        addLog(`Guardando fragmentos en base de datos vectorial...`, 'info');
        await saveChunks(processedChunks);
        addLog(`Guardado completado: ${processedChunks.length} vectores`, 'success');
        
        await updateDocumentStatus(id, 'processed', processedChunks.length);
        addLog(`Documento finalizado: ${file.name}`, 'success');

        setChunks(prev => [...prev, ...processedChunks]);
        setDocuments(prev => prev.map(doc => 
          doc.id === id ? { ...doc, status: 'processed', chunkCount: processedChunks.length } : doc
        ));

      } catch (error: unknown) {
        console.error("Error processing file:", error);
        const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
        addLog(`Error procesando ${file.name}: ${errorMessage}`, 'error');
      }
    }
    setIsProcessing(false);
    addLog(`Proceso total completado`, 'success');
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleExampleClick = async (q: string) => {
    setQuery(q);
    // Trigger query on next tick to ensure state update or use the string directly
    setTimeout(() => {
      const button = document.getElementById('search-button');
      button?.click();
    }, 0);
  };

  const handleQuery = async () => {
    if (!query.trim() || isQuerying || chunks.length === 0) return;

    setIsQuerying(true);
    addLog(`Nueva consulta: "${query}"`, 'info');
    const startTime = Date.now();

    try {
      // 1. Get query embedding
      addLog(`Generando embedding para la consulta...`, 'process');
      const queryEmbedding = await getEmbedding(query);
      addLog(`Embedding generado exitosamente`, 'success');

      // 2. Search relevant chunks
      addLog(`Buscando fragmentos más relevantes en la DB (${chunks.length} vectores)...`, 'process');
      const matchedChunks = searchChunks(queryEmbedding, chunks, 4);
      addLog(`${matchedChunks.length} fragmentos encontrados con alta similitud`, 'success');

      // 3. Generate response with context
      addLog(`Preparando contexto para el LLM...`, 'info');
      const context = matchedChunks.map(c => `[Fuente: ${c.sourceName}]\n${c.text}`).join("\n\n---\n\n");
      
      addLog(`Enviando prompt a Gemini 3 Flash...`, 'process');
      const { text: answer, tokens } = await generateRAGResponse(query, context);
      addLog(`Respuesta generada correctamente`, 'success');

      setResult({
        answer,
        sources: matchedChunks.map(c => ({ name: c.sourceName, text: c.text, score: c.score })),
        latency: Date.now() - startTime,
        tokens
      });
      setActiveTab('query');
    } catch (error) {
      console.error("Error in query:", error);
      addLog(`Error en la consulta: ${error instanceof Error ? error.message : 'Desconocido'}`, 'error');
    } finally {
      setIsQuerying(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteDocumentAndChunks(id);
      setDocuments(prev => prev.filter(d => d.id !== id));
      setChunks(prev => prev.filter(c => c.sourceId !== id));
      if (result && result.sources.some(s => documents.find(d => d.id === id)?.name === s.name)) {
        setResult(null);
      }
    } catch (error) {
      console.error("Error deleting document:", error);
    }
  };

  if (isLoading) {
    return (
      <div className="w-full h-screen bg-slate-950 flex flex-col items-center justify-center space-y-4">
        <Loader2 className="w-12 h-12 text-cyan-500 animate-spin" />
        <p className="text-slate-500 font-mono text-xs uppercase tracking-widest animate-pulse">Cargando base de conocimiento...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="w-full h-screen bg-slate-950 flex flex-col items-center justify-center p-6 bg-[radial-gradient(circle_at_50%_50%,rgba(6,182,212,0.1),transparent)]">
        <div className="max-w-md w-full bg-slate-900/50 backdrop-blur-xl border border-slate-800 p-10 rounded-3xl shadow-2xl text-center space-y-8 animate-in fade-in zoom-in duration-500">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 mx-auto flex items-center justify-center shadow-[0_0_30px_rgba(6,182,212,0.3)]">
            <Cpu className="w-10 h-10 text-white" />
          </div>
          
          <div>
            <h1 className="text-3xl font-bold text-white mb-3">RAG.System</h1>
            <p className="text-slate-400">Inicia sesión para persistir tus documentos y vectores en la nube de forma segura.</p>
          </div>

          {authError && (
             <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm flex items-center gap-3">
               <Activity className="w-4 h-4 flex-shrink-0" />
               <p className="text-left">{authError}</p>
             </div>
          )}

          <button 
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 text-slate-950 font-bold py-4 rounded-2xl transition-all shadow-[0_0_20px_rgba(6,182,212,0.2)] flex items-center justify-center gap-3 active:scale-[0.98]"
          >
            {isLoggingIn ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Zap className="w-5 h-5" />
            )}
            {isLoggingIn ? 'Iniciando sesión...' : 'Continuar con Google'}
          </button>

          <p className="text-[10px] text-slate-600 uppercase tracking-widest font-mono">
            Powered by Firebase & Google AI Studio
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-screen bg-slate-950 text-slate-200 font-sans flex flex-col overflow-hidden">
      {/* Header Navigation */}
      <nav className="h-16 border-b border-slate-800 flex items-center justify-between px-8 bg-slate-900/50 backdrop-blur-md z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-gradient-to-br from-cyan-500 to-blue-600 shadow-[0_0_15px_rgba(6,182,212,0.4)] flex items-center justify-center">
             <Cpu className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold tracking-tight text-lg">RAG.System v1.0</span>
        </div>
        <div className="flex items-center gap-6 text-sm font-medium">
          {[
            { id: 'documents', label: 'Documentos' },
            { id: 'query', label: 'Consultas' },
            { id: 'logs', label: 'Logs & Vectores' }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as 'documents' | 'query' | 'logs')}
              className={cn(
                "transition-all duration-300 py-5 px-1 relative",
                activeTab === tab.id ? "text-cyan-400" : "text-slate-400 hover:text-slate-200"
              )}
            >
              {tab.label}
              {activeTab === tab.id && (
                <motion.div 
                  layoutId="activeNav" 
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400" 
                />
              )}
            </button>
          ))}
          <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs ml-4">
            AI
          </div>
        </div>
      </nav>

      <main className="flex-1 flex overflow-hidden">
        {/* Sidebar: Knowledge Base */}
        <aside className="w-80 border-r border-slate-800 bg-slate-950/50 p-6 flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 flex items-center gap-2">
              <Database className="w-3 h-3" /> Base de Conocimiento
            </h3>
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessing}
              className="text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-2 py-1 rounded hover:bg-cyan-500/20 transition-all flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> AÑADIR
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              multiple 
              accept=".txt,.md,.pdf" 
              onChange={handleFileUpload} 
            />
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto pr-2 custom-scrollbar">
            {documents.length === 0 && !isProcessing && (
              <div className="text-center py-10 opacity-30">
                <FileText className="w-10 h-10 mx-auto mb-2" />
                <p className="text-xs">Sin documentos</p>
              </div>
            )}
            
            <AnimatePresence>
              {documents.map((doc) => (
                <motion.div 
                  key={doc.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className={cn(
                    "p-3 rounded-lg bg-slate-900 border border-slate-800 group relative transition-all duration-300",
                    doc.status === 'processed' && "border-l-2 border-l-cyan-500 shadow-[0_0_20px_rgba(6,182,212,0.05)]"
                  )}
                >
                  <div className="flex items-center gap-3">
                    {doc.status === 'processing' ? (
                      <Loader2 className="w-4 h-4 text-cyan-500 animate-spin" />
                    ) : (
                      <FileText className={cn("w-4 h-4", doc.status === 'error' ? "text-red-500" : "text-cyan-500")} />
                    )}
                    <div className="flex-1 truncate">
                      <p className="text-sm font-medium truncate">{doc.name}</p>
                      <p className={cn(
                        "text-[10px] uppercase font-semibold",
                        doc.status === 'processed' ? "text-cyan-400" : "text-slate-500"
                      )}>
                        {doc.status === 'processed' ? `Activo • ${doc.chunkCount} Chunks` : 'Procesando...'}
                      </p>
                    </div>
                    <button 
                      onClick={() => handleDelete(doc.id)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:text-red-400"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="mt-auto p-4 rounded-xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800">
            <div className="flex justify-between items-end mb-2">
              <p className="text-[10px] text-slate-500 uppercase">Salud de la DB</p>
              <div className="flex items-center gap-1 text-[10px] text-cyan-400">
                <Zap className="w-2.5 h-2.5" />
                <span>{chunks.length} vectores</span>
              </div>
            </div>
            <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
               <motion.div 
                 initial={{ width: 0 }}
                 animate={{ width: `${Math.min(100, (parseFloat(usedSpace) / 10) * 100)}%` }}
                 className="h-full bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)]" 
               />
            </div>
            <p className="text-[10px] mt-2 text-right text-cyan-400">{usedSpace}MB / 10MB Simulados</p>
          </div>
        </aside>

        {/* Main Interface */}
        <section className="flex-1 flex flex-col p-8 bg-[radial-gradient(circle_at_50%_-20%,rgba(6,182,212,0.15),transparent)] overflow-hidden">
          <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full">
            
            {activeTab === 'documents' && (
               <div className="flex-1 flex flex-col overflow-hidden">
                  {documents.length === 0 && !isProcessing ? (
                    <div className="flex-1 flex flex-col justify-center items-center text-center space-y-6">
                      <div className="w-20 h-20 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-500">
                        <Database className="w-10 h-10" />
                      </div>
                      <div>
                        <h2 className="text-2xl font-bold text-white mb-2">Gestión de Conocimiento</h2>
                        <p className="text-slate-400 max-w-md">Sube archivos PDF, Markdown o Texto para que la IA los procese y puedas consultarlos en tiempo real.</p>
                      </div>
                      <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold px-8 py-3 rounded-xl transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)] flex items-center gap-2"
                      >
                        <Plus className="w-5 h-5" /> Subir Documentos
                      </button>
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col overflow-hidden space-y-8">
                       {/* Ingestion Dashboard Header */}
                       <div className="flex items-center justify-between">
                          <div>
                            <h2 className="text-xl font-bold text-white flex items-center gap-2">
                               <Database className="w-5 h-5 text-cyan-500" /> Dashboard de Ingesta
                            </h2>
                            <p className="text-slate-500 text-sm">Monitorea el proceso de vectorización y fragmentación en tiempo real.</p>
                          </div>
                          <div className="flex items-center gap-3">
                             <div className="text-right">
                                <p className="text-[10px] text-slate-500 uppercase font-bold">Documentos Totales</p>
                                <p className="text-lg font-bold text-white">{documents.length}</p>
                             </div>
                             <div className="w-px h-8 bg-slate-800 mx-2" />
                             <div className="text-right">
                                <p className="text-[10px] text-slate-500 uppercase font-bold">Vectores Generados</p>
                                <p className="text-lg font-bold text-cyan-400">{totalChunks}</p>
                             </div>
                          </div>
                       </div>

                       {/* Live Pipeline Visualization (Global or for newest doc) */}
                       <div className="p-8 bg-slate-900/40 border border-slate-800 rounded-3xl relative overflow-hidden backdrop-blur-sm">
                          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(6,182,212,0.05),transparent)] pointer-events-none" />
                          
                          <div className="flex items-center justify-between mb-8">
                             <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500 flex items-center gap-2">
                                <Activity className="w-3 h-3 text-cyan-500" /> Pipeline de Procesamiento
                             </h3>
                             <button 
                                onClick={() => setActiveTab('logs')}
                                className="text-[10px] text-cyan-400 hover:underline flex items-center gap-1"
                             >
                                VER LOGS DETALLADOS <Plus className="w-2 h-2" />
                             </button>
                          </div>

                          <div className="flex flex-col md:flex-row items-center justify-between gap-6 relative">
                             {/* Step 1: Upload */}
                             <div className="flex flex-col items-center gap-3 z-10 w-32">
                                <div className={cn(
                                  "w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all duration-500",
                                  isProcessing ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 scale-110 shadow-cyan-500/10" : "bg-slate-800 text-slate-500 border border-slate-700"
                                )}>
                                   <Plus className="w-6 h-6" />
                                </div>
                                <div className="text-center">
                                  <p className="text-[10px] font-bold text-white uppercase tracking-wider">Carga</p>
                                  <p className="text-[9px] text-slate-500">I/O Firestore</p>
                                </div>
                             </div>

                             <div className="w-1 md:flex-1 h-12 md:h-px bg-slate-800 relative">
                                {isProcessing && (
                                  <motion.div 
                                    animate={{ x: ["0%", "100%"] }} 
                                    transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                                    className="absolute md:top-1/2 md:-translate-y-1/2 left-0 w-4 h-4 md:w-8 md:h-1 bg-cyan-500/50 rounded-full blur-[2px]" 
                                  />
                                )}
                             </div>

                             {/* Step 2: Extraction */}
                             <div className="flex flex-col items-center gap-3 z-10 w-32">
                                <div className={cn(
                                  "w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all duration-500",
                                  isProcessing ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 scale-110 shadow-blue-500/10" : "bg-slate-800 text-slate-500 border border-slate-700"
                                )}>
                                   <FileText className="w-6 h-6" />
                                </div>
                                <div className="text-center">
                                  <p className="text-[10px] font-bold text-white uppercase tracking-wider">Extracción</p>
                                  <p className="text-[9px] text-slate-500">Parsing PDF/Text</p>
                                </div>
                             </div>

                             <div className="w-1 md:flex-1 h-12 md:h-px bg-slate-800 relative">
                                {isProcessing && (
                                  <motion.div 
                                    animate={{ x: ["0%", "100%"] }} 
                                    transition={{ duration: 1.5, repeat: Infinity, ease: "linear", delay: 0.5 }}
                                    className="absolute md:top-1/2 md:-translate-y-1/2 left-0 w-4 h-4 md:w-8 md:h-1 bg-blue-500/50 rounded-full blur-[2px]" 
                                  />
                                )}
                             </div>

                             {/* Step 3: Embeddings */}
                             <div className="flex flex-col items-center gap-3 z-10 w-32">
                                <div className={cn(
                                  "w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all duration-500",
                                  isProcessing ? "bg-purple-500/20 text-purple-400 border border-purple-500/30 scale-110 shadow-purple-500/10" : "bg-slate-800 text-slate-500 border border-slate-700"
                                )}>
                                   <Zap className="w-6 h-6" />
                                </div>
                                <div className="text-center">
                                  <p className="text-[10px] font-bold text-white uppercase tracking-wider">Embeddings</p>
                                  <p className="text-[9px] text-slate-500">Gemini-2 768d</p>
                                </div>
                             </div>

                             <div className="w-1 md:flex-1 h-12 md:h-px bg-slate-800 relative">
                                {isProcessing && (
                                  <motion.div 
                                    animate={{ x: ["0%", "100%"] }} 
                                    transition={{ duration: 1.5, repeat: Infinity, ease: "linear", delay: 1 }}
                                    className="absolute md:top-1/2 md:-translate-y-1/2 left-0 w-4 h-4 md:w-8 md:h-1 bg-purple-500/50 rounded-full blur-[2px]" 
                                  />
                                )}
                             </div>

                             {/* Step 4: Storage */}
                             <div className="flex flex-col items-center gap-3 z-10 w-32">
                                <div className={cn(
                                  "w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all duration-500",
                                  isProcessing ? "bg-green-500/20 text-green-400 border border-green-500/30" : "bg-slate-800 text-slate-500 border border-slate-700"
                                )}>
                                   <CheckCircle2 className="w-6 h-6" />
                                </div>
                                <div className="text-center">
                                  <p className="text-[10px] font-bold text-white uppercase tracking-wider">Indexado</p>
                                  <p className="text-[9px] text-slate-500">Vector Store</p>
                                </div>
                             </div>
                          </div>
                       </div>

                       {/* Recent Logs Preview */}
                       <div className="flex-1 flex flex-col overflow-hidden">
                          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Actividad Reciente del Proceso</h3>
                          <div className="flex-1 bg-slate-950 border border-slate-800 rounded-2xl p-4 font-mono text-[10px] overflow-y-auto custom-scrollbar">
                             {processLogs.length === 0 ? (
                               <div className="h-full flex items-center justify-center text-slate-700 italic">
                                 Esperando inicio de proceso...
                               </div>
                             ) : (
                               processLogs.slice(0, 10).map((log, i) => (
                                 <div key={i} className="flex gap-4 py-1 border-b border-slate-900 last:border-0">
                                   <span className="text-slate-600">[{log.timestamp}]</span>
                                   <span className={cn(
                                     "uppercase font-bold w-12",
                                     log.type === 'error' ? "text-red-500" : 
                                     log.type === 'success' ? "text-green-500" : 
                                     log.type === 'process' ? "text-cyan-500" : "text-blue-500"
                                   )}>{log.type}</span>
                                   <span className="text-slate-400">{log.message}</span>
                                 </div>
                               ))
                             )}
                          </div>
                       </div>
                    </div>
                  )}
               </div>
            )}

            {activeTab === 'query' && (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Result Box */}
                <div className="flex-1 mb-6 rounded-2xl bg-slate-900/40 border border-slate-800 p-8 relative overflow-y-auto shadow-2xl backdrop-blur-sm custom-scrollbar">
                  <div className="absolute top-0 right-0 p-4">
                    <span className="text-[10px] font-mono text-cyan-500/60 uppercase tracking-widest">
                       {isQuerying ? 'Procesando consulta...' : result ? `ID: VEC-${Math.floor(Math.random()*9000)+1000}-X` : 'Esperando consulta'}
                    </span>
                  </div>
                  
                  {isQuerying ? (
                    <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-4">
                      <Loader2 className="w-12 h-12 animate-spin text-cyan-500" />
                      <p className="font-mono text-xs uppercase tracking-widest animate-pulse">Analizando vectores contextuales...</p>
                    </div>
                  ) : result ? (
                    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                      <div className="flex items-center justify-between mb-4">
                        <h2 className="text-cyan-400 text-xs font-bold uppercase tracking-widest flex items-center gap-2">
                          <CheckCircle2 className="w-3 h-3" /> Resultado de la Síntesis
                        </h2>
                        <button 
                          onClick={() => setShowPipeline(!showPipeline)}
                          className={cn(
                            "text-[10px] px-3 py-1 rounded-full border transition-all flex items-center gap-2 uppercase tracking-tighter font-bold",
                            showPipeline ? "bg-cyan-500/20 border-cyan-500/50 text-cyan-400" : "bg-slate-800 border-slate-700 text-slate-500 hover:border-slate-500"
                          )}
                        >
                          <Activity className="w-2.5 h-2.5" />
                          {showPipeline ? "Ocultar Proceso" : "Visualizar Proceso"}
                        </button>
                      </div>

                      {showPipeline && (
                        <div className="mb-8 p-5 rounded-2xl bg-slate-950/50 border border-slate-800 flex flex-col md:flex-row items-center justify-between gap-4 relative overflow-hidden">
                           <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(6,182,212,0.05),transparent)] pointer-events-none" />
                           
                           {/* Step 1 */}
                           <div className="flex flex-col items-center gap-1.5 z-10">
                              <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400 shadow-lg">
                                <Search className="w-4 h-4" />
                              </div>
                              <span className="text-[9px] uppercase font-bold text-slate-600">Consulta</span>
                           </div>

                           <div className="hidden md:block flex-1 h-px bg-gradient-to-r from-slate-800 via-cyan-500/30 to-slate-800 relative">
                              <motion.div 
                                animate={{ x: ["0%", "100%"] }} 
                                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                                className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-cyan-500/40 rounded-full blur-[2px]" 
                              />
                           </div>

                           {/* Step 2 */}
                           <div className="flex flex-col items-center gap-1.5 z-10">
                              <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-cyan-500 shadow-lg">
                                <Zap className="w-4 h-4" />
                              </div>
                              <span className="text-[9px] uppercase font-bold text-slate-600">Vectores</span>
                           </div>

                           <div className="hidden md:block flex-1 h-px bg-gradient-to-r from-slate-800 via-cyan-500/30 to-slate-800 relative">
                             <motion.div 
                                animate={{ x: ["0%", "100%"] }} 
                                transition={{ duration: 2, repeat: Infinity, ease: "linear", delay: 0.5 }}
                                className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-cyan-500/40 rounded-full blur-[2px]" 
                              />
                           </div>

                           {/* Step 3 */}
                           <div className="flex flex-col items-center gap-1.5 z-10">
                              <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-blue-500 shadow-lg">
                                <FileText className="w-4 h-4" />
                              </div>
                              <span className="text-[9px] uppercase font-bold text-slate-600">Contexto</span>
                           </div>

                           <div className="hidden md:block flex-1 h-px bg-gradient-to-r from-slate-800 via-cyan-500/30 to-slate-800 relative">
                             <motion.div 
                                animate={{ x: ["0%", "100%"] }} 
                                transition={{ duration: 2, repeat: Infinity, ease: "linear", delay: 1 }}
                                className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-cyan-500/40 rounded-full blur-[2px]" 
                              />
                           </div>

                           {/* Step 4 */}
                           <div className="flex flex-col items-center gap-1.5 z-10">
                              <div className="w-9 h-9 rounded-xl bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-500 shadow-lg">
                                <CheckCircle2 className="w-4 h-4" />
                              </div>
                              <span className="text-[9px] uppercase font-bold text-cyan-500">Respuesta</span>
                           </div>
                        </div>
                      )}

                      <div className="text-lg leading-relaxed text-slate-100 font-light prose prose-invert max-w-none">
                        {result.answer.split('\n').map((para, i) => (
                           <p key={i} className="mb-4">{para}</p>
                        ))}
                      </div>
                      
                      <div className="space-y-4 pt-6 border-t border-slate-800">
                        <h4 className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-2">
                          <Activity className="w-3 h-3" /> Fuentes Relevantes
                        </h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {result.sources.map((source, idx) => (
                            <div 
                              key={idx} 
                              className="text-xs py-3 px-4 rounded bg-slate-800/50 border border-slate-700 hover:border-cyan-500/30 transition-all group"
                            >
                              <div className="flex items-center gap-2 mb-2 text-cyan-400 font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
                                {source.name}
                              </div>
                              <p className="text-slate-400 line-clamp-3 italic">"{source.text.slice(0, 150)}..."</p>
                              <div className="mt-2 text-[10px] text-slate-500 flex justify-between">
                                  <span>Similitud: {(source.score * 100).toFixed(1)}%</span>
                                  <span className="opacity-0 group-hover:opacity-100 transition-opacity">Ver fragmento</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center space-y-4">
                      <Search className="w-16 h-16 opacity-20" />
                      <div>
                        <p className="text-lg font-medium">Motor listo para consultas</p>
                        <p className="text-sm max-w-xs mx-auto">Haz una pregunta sobre tus documentos para activar la búsqueda semántica.</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Input Bar */}
                <div className="h-20 bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl flex items-center px-6 gap-4 focus-within:border-cyan-500/50 transition-all">
                  <div className={cn(
                    "w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center transition-all",
                    isQuerying ? "text-cyan-500" : "text-slate-500"
                  )}>
                    {isQuerying ? <Loader2 className="w-5 h-5 animate-spin" /> : <Zap className="w-5 h-5" />}
                  </div>
                  <input 
                    type="text" 
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleQuery()}
                    disabled={isQuerying || chunks.length === 0}
                    className="bg-transparent flex-1 outline-none text-slate-200 placeholder:text-slate-600 text-lg disabled:opacity-50" 
                    placeholder={chunks.length > 0 ? "Pregunta lo que sea a tus documentos..." : "Sube documentos para empezar..."}
                  />
                  <button 
                    id="search-button"
                    onClick={handleQuery}
                    disabled={isQuerying || !query.trim() || chunks.length === 0}
                    className="bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 font-bold px-8 py-2 rounded-xl transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)] disabled:shadow-none flex items-center gap-2"
                  >
                    Consultar
                  </button>
                </div>

                <div className="mt-4 flex flex-wrap gap-2 justify-center">
                  {EXAMPLE_QUERIES.map((q, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleExampleClick(q)}
                      disabled={isQuerying || chunks.length === 0}
                      className="text-[10px] bg-slate-800/50 hover:bg-slate-800 border border-slate-700 hover:border-cyan-500/50 text-slate-400 hover:text-cyan-400 px-3 py-1.5 rounded-lg transition-all"
                    >
                      {q}
                    </button>
                  ))}
                </div>

                <div className="mt-4 flex gap-6 justify-center">
                  <div className="flex items-center gap-2 text-[10px] text-slate-500 uppercase tracking-widest font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> LLM: Gemini 3 Flash
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-slate-500 uppercase tracking-widest font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-500"></span> Vector: Gemini-Embedding-2
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-slate-500 uppercase tracking-widest font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span> Modo: Búsqueda Local
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'logs' && (
              <div className="flex-1 flex flex-col overflow-hidden space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex bg-slate-900 p-1 rounded-xl border border-slate-800">
                    <button 
                      onClick={() => setViewMode('terminal')}
                      className={cn(
                        "px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all",
                        viewMode === 'terminal' ? "bg-slate-800 text-cyan-400 shadow-md" : "text-slate-500 hover:text-slate-300"
                      )}
                    >
                      Terminal
                    </button>
                    <button 
                      onClick={() => setViewMode('fragments')}
                      className={cn(
                        "px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all",
                        viewMode === 'fragments' ? "bg-slate-800 text-cyan-400 shadow-md" : "text-slate-500 hover:text-slate-300"
                      )}
                    >
                      Fragmentos (Vectores)
                    </button>
                  </div>
                  {viewMode === 'terminal' && (
                    <button 
                      onClick={() => setProcessLogs([])}
                      className="text-[10px] text-slate-500 hover:text-red-400 transition-colors uppercase font-bold"
                    >
                      Clear Logs
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-hidden bg-slate-900 border border-slate-800 rounded-2xl flex flex-col">
                  {viewMode === 'terminal' ? (
                    <div className="flex-1 overflow-y-auto p-6 font-mono text-xs custom-scrollbar">
                      <div className="flex items-center gap-2 mb-4 text-cyan-400/50 border-b border-slate-800 pb-2 uppercase tracking-widest font-bold">
                        <Activity className="w-4 h-4" /> System_Output.log
                      </div>
                      <div className="space-y-2">
                        {processLogs.length === 0 ? (
                          <div className="h-40 flex items-center justify-center text-slate-700 italic">
                            Sin actividad en el buffer
                          </div>
                        ) : (
                          processLogs.map((log, i) => (
                            <div key={i} className="flex gap-4 animate-in fade-in slide-in-from-left-2 duration-300">
                              <span className="text-slate-600 shrink-0">[{log.timestamp}]</span>
                              <span className={cn(
                                "shrink-0 w-20 uppercase font-bold",
                                log.type === 'error' ? "text-red-500" : 
                                log.type === 'success' ? "text-green-500" : 
                                log.type === 'process' ? "text-cyan-500" : "text-blue-500"
                              )}>
                                {log.type}
                              </span>
                              <span className="text-slate-300">{log.message}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col overflow-hidden">
                       <div className="p-4 border-b border-slate-800 bg-slate-900/50 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                          <div className="flex flex-col">
                             <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Base de Datos Vectorial: {chunks.length} Fragmentos</span>
                             <div className="flex gap-2 items-center mt-1">
                                <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
                                <span className="text-[9px] text-cyan-500 uppercase font-mono tracking-tighter">Indexing Active</span>
                             </div>
                          </div>
                          
                          <div className="flex items-center gap-2">
                             <span className="text-[9px] text-slate-500 uppercase font-bold">Filtrar por:</span>
                             <select 
                                value={fragmentFilter}
                                onChange={(e) => setFragmentFilter(e.target.value)}
                                className="bg-slate-800 border border-slate-700 text-[10px] text-slate-300 rounded px-2 py-1 outline-none focus:border-cyan-500/50 transition-all"
                             >
                                <option value="all">Todos los documentos</option>
                                {documents.map(doc => (
                                   <option key={doc.id} value={doc.id}>{doc.name}</option>
                                ))}
                             </select>
                          </div>
                       </div>
                       <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 md:grid-cols-2 gap-4 custom-scrollbar">
                          {chunks.filter(c => fragmentFilter === 'all' || c.sourceId === fragmentFilter).length === 0 ? (
                            <div className="col-span-full h-40 flex items-center justify-center text-slate-600 uppercase tracking-widest text-[10px]">
                               {fragmentFilter === 'all' ? 'Cero vectores en memoria' : 'Sin fragmentos para este documento'}
                            </div>
                          ) : (
                            chunks.filter(c => fragmentFilter === 'all' || c.sourceId === fragmentFilter).map((chunk, i) => (
                              <div key={i} className="p-4 rounded-xl bg-slate-950 border border-slate-800 hover:border-cyan-500/30 transition-all group">
                                 <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">#{chunk.index} | {chunk.sourceName}</span>
                                    <Database className="w-3 h-3 text-cyan-500/30 group-hover:text-cyan-500 transition-colors" />
                                 </div>
                                 <p className="text-[11px] text-slate-400 line-clamp-3 font-light leading-relaxed mb-3">"{chunk.text}"</p>
                                 <div className="flex items-center justify-between">
                                    <div className="flex gap-1 overflow-hidden h-1 items-end">
                                       {[...Array(20)].map((_, j) => (
                                          <div key={j} className="w-1 bg-cyan-500/20" style={{ height: `${Math.random() * 100}%` }} />
                                       ))}
                                    </div>
                                    <span className="text-[9px] text-slate-600 font-mono">768D EMBEDDING</span>
                                 </div>
                              </div>
                            ))
                          )}
                       </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Bottom Metrics */}
      <footer className="h-12 border-t border-slate-800 bg-slate-950 px-8 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="text-[10px] font-mono text-slate-500 flex items-center gap-1.5">
            LATENCIA: <span className={cn(result ? "text-green-400" : "text-slate-700")}>{result ? `${result.latency}ms` : '--'}</span>
          </span>
          <span className="text-[10px] font-mono text-slate-500 flex items-center gap-1.5">
            CHUNKS PROCESADOS: <span className="text-cyan-400">{totalChunks}</span>
          </span>
          <span className="text-[10px] font-mono text-slate-500 flex items-center gap-1.5">
            ESTADO: <span className={cn(isQuerying ? "text-amber-400 animate-pulse" : "text-green-400 uppercase")}>{isQuerying ? "Pensando..." : "Sistema Online"}</span>
          </span>
        </div>
        <div className="text-[10px] font-mono text-slate-600 hidden md:block">
          Cifrado SSL activo. Datos procesados localmente vía Google Cloud.
        </div>
      </footer>

      {/* Custom Global CSS for Scrollbars */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #1e293b;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #334155;
        }
      `}</style>
    </div>
  );
}
