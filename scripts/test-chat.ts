async function testChat(question: string) {
  console.log(`\n❓ Question : ${question}`);

  const response = await fetch("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: question }],
    }),
  });

  const text = await response.text();
  console.log(`💬 Réponse : ${text}`);
}

async function main() {
  await testChat("Quels sont vos délais de livraison ?");
  await testChat("Quels moyens de paiement acceptez-vous ?");
  await testChat("Est-ce que vous vendez des téléphones ?");
  await testChat("Comment retourner un article ?");
}

main();