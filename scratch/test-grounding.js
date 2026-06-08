import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getApiKey() {
  const envPath = path.resolve(__dirname, '../.env.local');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const parts = line.split('=');
      if (parts[0].trim() === 'VITE_GEMINI_API_KEY') {
        return parts.slice(1).join('=').trim();
      }
    }
  }
  return process.env.VITE_GEMINI_API_KEY;
}

const apiKey = getApiKey();
if (!apiKey) {
  console.error("VITE_GEMINI_API_KEY not found in .env.local or process.env");
  process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

async function run() {
  console.log("Testing new Gemini key WITH Google Search grounding...");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Who won the latest UEFA Champions League? Search the web." }] }],
        tools: [{ google_search: {} }]
      })
    });
    console.log("Status code:", res.status);
    const data = await res.json();
    console.log("Response text:", data.candidates?.[0]?.content?.parts?.[0]?.text);
    console.log("Grounding metadata sources:", data.candidates?.[0]?.groundingMetadata?.groundingChunks?.length || 0);
  } catch (e) {
    console.error("Error fetching Gemini:", e.message);
  }
}

run();
