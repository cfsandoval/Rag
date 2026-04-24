import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function getEmbedding(text: string) {
  try {
    const result = await ai.models.embedContent({
      model: "gemini-embedding-2-preview",
      contents: [{ parts: [{ text }] }],
    });
    return result.embeddings[0].values;
  } catch (error) {
    console.error("Error generating embedding:", error);
    throw error;
  }
}

export async function generateRAGResponse(query: string, context: string) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Eres un asistente experto en análisis de documentos. Utiliza el siguiente contexto para responder a la pregunta del usuario. Si la información no está en el contexto, indícalo claramente.
              
CONTEXTO:
${context}

PREGUNTA:
${query}

RESPUESTA (en español, con tono profesional y directo):`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.2,
      }
    });

    return {
      text: response.text || "",
      tokens: 0, // Gemini SDK doesn't expose metadata easily in this version, but we can estimate or just show 0
    };
  } catch (error) {
    console.error("Error generating RAG response:", error);
    throw error;
  }
}
