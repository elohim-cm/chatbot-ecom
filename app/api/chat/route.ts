import { NextRequest } from "next/server";
import postgres from "postgres";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { embed, streamText, createUIMessageStream, createUIMessageStreamResponse } from "ai";

function directTextResponse(text: string) {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const id = "direct-response";
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    },
  });

  return createUIMessageStreamResponse({ stream });
}

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY,
});

// ✅ Singleton PostgreSQL
let sqlClient: ReturnType<typeof postgres> | null = null;
function getSql() {
  if (!sqlClient) {
    sqlClient = postgres(process.env.DATABASE_URL!, {
      ssl: "require",
      max: 5,
      idle_timeout: 20,
    });
  }
  return sqlClient;
}

const SIMILARITY_THRESHOLD = 0.5;
const TOP_K = 4;

type IncomingMessage = {
  role: string;
  content?: string;
  parts?: { type: string; text: string }[];
};

export async function POST(req: NextRequest) {
  try {
    const { messages } = (await req.json()) as { messages: IncomingMessage[] };

    const lastMessage = messages[messages.length - 1];
    const lastUserMessage =
      lastMessage?.content ??
      lastMessage?.parts
        ?.filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");

    if (!lastUserMessage) {
      return new Response("Message manquant", { status: 400 });
    }

    // 0. Détecter les messages conversationnels simples (sans RAG)
    const normalized = lastUserMessage.toLowerCase().trim().replace(/[!?.,]/g, "");
    const greetings = [
        "bonjour", "salut", "bonsoir", "hello", "hey", "coucou",
        "bjr", "slt", "cc", "yo",
    ];
    const thanks = ["merci", "thanks", "thank you", "mrc"];
    const goodbyes = ["au revoir", "bye", "a plus", "à plus", "ciao", "a bientot", "à bientôt"];
    const howAreYou = ["ca va", "ça va", "comment vas tu", "comment ca va", "comment ça va", "tu vas bien"];

    let directResponse: string | null = null;

    if (greetings.some((g) => normalized === g || normalized.startsWith(g + " "))) {
        directResponse = "Bonjour ! Comment puis-je vous aider aujourd'hui ?";
    } else if (thanks.some((t) => normalized === t || normalized.startsWith(t + " "))) {
        directResponse = "Avec plaisir ! N'hésitez pas si vous avez d'autres questions.";
    } else if (goodbyes.some((g) => normalized === g || normalized.startsWith(g + " "))) {
        directResponse = "Au revoir ! Bonne journée à vous.";
    } else if (howAreYou.some((h) => normalized.includes(h))) {
        directResponse = "Je vais très bien, merci ! Comment puis-je vous aider ?";
    }

    if (directResponse) { return directTextResponse(directResponse);}

    // 1. Embedding de la question
    const { embedding } = await embed({
      model: google.textEmbeddingModel("gemini-embedding-001"),
      value: lastUserMessage,
      providerOptions: {
        google: {
          outputDimensionality: 768,
          taskType: "RETRIEVAL_QUERY",
        },
      },
    });

    // 2. Recherche vectorielle (connexion réutilisée)
    const sql = getSql();
    const vectorStr = JSON.stringify(embedding);

    const results = await sql<{ content: string; similarity: number }[]>`
      SELECT
        content,
        metadata,
        1 - (embedding <=> ${vectorStr}::vector) AS similarity
      FROM documents
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT ${TOP_K}
    `;

    const relevantDocs = results.filter(
      (r) => r.similarity >= SIMILARITY_THRESHOLD
    );

    // 3. Messages au format streamText
    const conversationMessages = messages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content:
        msg.content ??
        msg.parts
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("") ??
        "",
    }));

    // 4. Fallback WhatsApp — SANS appel LLM
    if (relevantDocs.length === 0) {
        const fallbackMessage = "Je n'ai pas cette information. Contactez notre service client sur WhatsApp : https://wa.me/237658994705";
        return directTextResponse(fallbackMessage);
    }

    // 5. Contexte
    const context = relevantDocs
      .map((doc, i) => `[Document ${i + 1}]\n${doc.content}`)
      .join("\n\n");

    const systemPrompt = `Tu es un assistant client pour un site e-commerce. Tu réponds UNIQUEMENT en français, de manière polie, concise et utile.

    RÈGLES STRICTES :
    - Réponds UNIQUEMENT à partir des informations fournies dans le CONTEXTE ci-dessous.
    - Si le message est une salutation (bonjour, salut, etc.), réponds simplement "Bonjour ! Comment puis-je vous aider aujourd'hui ?" sans utiliser le contexte.
    - Si le contexte ne contient pas la réponse, réponds exactement : "Je n'ai pas cette information. Contactez notre service client sur WhatsApp : https://wa.me/237658994705"
    - Ne JAMAIS inventer d'information.
    - Tu peux assembler, reformuler ou résumer les informations du contexte.
    - Réponses COURTES : 1 à 2 phrases maximum quand la question est simple. Développe seulement si la question l'exige explicitement.
    - Ne récite jamais tout le contexte. Sélectionne uniquement l'information demandée.

    CONTEXTE : ${context}`;

    // 6. Génération avec 20b + reasoningEffort low
    try {
      const result = await streamText({
        model: groq("openai/gpt-oss-20b"),
        system: systemPrompt,
        messages: conversationMessages,
        maxOutputTokens: 500,
        providerOptions: {
          groq: { reasoningEffort: "low" },
        },
      });

      return result.toUIMessageStreamResponse();
    } catch (groqError) {
      console.error("Groq a échoué, basculement sur Gemini :", groqError);

      const result = await streamText({
        model: google("gemini-2.0-flash"),
        system: systemPrompt,
        messages: conversationMessages,
        maxOutputTokens: 500,
      });

      return result.toUIMessageStreamResponse();
    }
  } catch (error: unknown) {
    console.error("Erreur dans /api/chat :", error);
    return new Response("Une erreur est survenue.", { status: 500 });
  }
}