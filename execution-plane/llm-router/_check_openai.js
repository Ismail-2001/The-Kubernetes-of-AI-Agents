const OpenAI = require('./node_modules/openai');
const c = OpenAI.Chat;
console.log('Chat keys:', Object.keys(c).join(', '));
if (c.Completions) {
  console.log('Completions static props:', Object.getOwnPropertyNames(c.Completions).join(', '));
}
// Try to find CompletionUsage
const fullOpenAI = require('./node_modules/openai/index.js');
console.log('Has CompletionUsage:', 'CompletionUsage' in fullOpenAI);
