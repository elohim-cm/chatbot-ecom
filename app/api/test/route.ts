import { NextResponse } from "next/server";
import postgres from "postgres";
import Groq from "groq-sdk";

export async function GET() {
  const resultats: any = {
    env: {},
    neon: {},
    groq: {},
  };

  // 1. Vérifier les variables d'environnement
  resultats.env = {
    GROQ_API_KEY: process.env.GROQ_API_KEY ? "✅ présente" : "❌ manquante",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ? "✅ présente" : "❌ manquante",
    DATABASE_URL: process.env.DATABASE_URL ? "✅ présente" : "❌ manquante",
  };

  // 2. Vérifier la connexion à Neon
  try {
    const sql = postgres(process.env.DATABASE_URL!, { ssl: "require" });
    const rows = await sql`SELECT version() AS version, NOW() AS now`;
    resultats.neon = {
      statut: "✅ connecté",
      version_postgres: rows[0].version.split(" ")[0] + " " + rows[0].version.split(" ")[1],
      heure_serveur: rows[0].now,
    };
    await sql.end();
  } catch (error: any) {
    resultats.neon = {
      statut: "❌ échec",
      erreur: error.message,
    };
  }

  // 3. Vérifier l'API Groq
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: "Réponds juste par: OK" }],
      max_tokens: 100,
    });
    resultats.groq = {
      statut: "✅ répond",
      reponse: completion.choices[0]?.message?.content,
    };
  } catch (error: any) {
    resultats.groq = {
      statut: "❌ échec",
      erreur: error.message,
    };
  }

  return NextResponse.json(resultats, { status: 200 });
}