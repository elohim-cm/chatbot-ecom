import { config } from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";
import postgres from "postgres";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embedMany } from "ai";

// Charger les variables d'environnement de Next.js
config({ path: ".env.local" });

// ✅ Créer l'instance Google avec la clé explicitement passée
const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

type KnowledgeItem = {
  content: string;
  metadata?: Record<string, unknown>;
};

async function main() {
  console.log("🚀 Démarrage du script d'indexation...\n");

  // 1. Vérifier les variables d'environnement
  if (!process.env.DATABASE_URL) {
    throw new Error("❌ DATABASE_URL manquante dans .env.local");
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("❌ GEMINI_API_KEY manquante dans .env.local");
  }
  console.log("✅ Variables d'environnement chargées");
  console.log(`   GEMINI_API_KEY commence par : ${process.env.GEMINI_API_KEY.substring(0, 8)}...`);

  // 2. Lire le fichier de connaissances
  const knowledgePath = join(process.cwd(), "data", "knowledge.json");
  const raw = readFileSync(knowledgePath, "utf-8");
  const items: KnowledgeItem[] = JSON.parse(raw);
  console.log(`✅ ${items.length} documents trouvés dans knowledge.json\n`);

  // 3. Générer les embeddings avec Gemini
  console.log("🧠 Génération des embeddings avec Gemini...");
  const { embeddings } = await embedMany({
    model: google.textEmbeddingModel("gemini-embedding-001"),
    values: items.map((item) => item.content),
    providerOptions: {
      google: {
        outputDimensionality: 768, // Doit correspondre à vector(768) dans la table
        taskType: "RETRIEVAL_DOCUMENT",
      },
    },
  });
  console.log(`✅ ${embeddings.length} vecteurs générés`);
  console.log(`   Dimension d'un vecteur : ${embeddings[0].length}\n`);

  // 4. Connexion à Neon
  console.log("🔌 Connexion à Neon...");
  const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });
  console.log("✅ Connecté\n");

  // 5. Vider la table avant réindexation
  console.log("🧹 Nettoyage de la table documents...");
  await sql`TRUNCATE TABLE documents RESTART IDENTITY`;
  console.log("✅ Table nettoyée\n");

  // 6. Insérer les documents et leurs vecteurs
  console.log("💾 Insertion dans la base de données...");
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const embedding = embeddings[i];
    const metadata = item.metadata ?? {};

    await sql`
      INSERT INTO documents (content, embedding, metadata)
      VALUES (
        ${item.content},
        ${JSON.stringify(embedding)}::vector,
        ${JSON.stringify(metadata)}::jsonb
      )
    `;
    console.log(`   ✅ Document ${i + 1}/${items.length} inséré`);
  }

  // 7. Vérification finale
  const count = await sql`SELECT COUNT(*)::int AS total FROM documents`;
  console.log(`\n🎉 Indexation terminée ! ${count[0].total} documents dans la base.`);

  await sql.end();
}

main().catch((error) => {
  console.error("\n❌ Erreur :", error.message);
  process.exit(1);
});