const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'components', 'FeasibilitySearch.tsx');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

const keywords = ['generatePrintableReport', 'downloadMarkdownReport', 'window.open', 'print', 'chatbot', 'chatWithGemini'];

keywords.forEach(keyword => {
  console.log(`=== Matches for "${keyword}": ===`);
  lines.forEach((line, idx) => {
    if (line.includes(keyword)) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  });
});
