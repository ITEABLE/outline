// Guesses the language of a snippet. Returns a code-block language id ("plaintext" when unsure).
export function detect(src) {
  const s = String(src || '').trim();
  if (!s) return 'plaintext';
  if (/^[\[{]/.test(s)) { try { JSON.parse(s); return 'json'; } catch {} }
  const score = { json: 0, python: 0, javascript: 0, bash: 0, sql: 0 };
  const hit = (lang, re, w = 1) => { if (re.test(s)) score[lang] += w; };

  hit('json', /^[\[{][\s\S]*"[^"\n]+"\s*:/, 2);

  hit('sql', /^\s*(select\b[\s\S]*\bfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(table|index|view)|alter\s+table|drop\s+(table|index)|with\s+\w+\s+as\s*\()/i, 3);
  hit('sql', /\b(where|join|group\s+by|order\s+by|values)\b/i, 1);

  hit('python', /^\s*def\s+\w+\s*\(.*\)\s*(->.*)?:\s*$/m, 3);
  hit('python', /^\s*class\s+\w+(\(.*\))?:\s*$/m, 3);
  hit('python', /^\s*(import\s+\w+|from\s+[\w.]+\s+import\s)/m, 2);
  hit('python', /^\s*(if|elif|else|for|while|with|try|except)\b.*:\s*$/m, 2);
  hit('python', /\b(print\(|self\.|None\b|True\b|False\b|elif\b|lambda\b|__\w+__)/, 1);

  hit('javascript', /\b(const|let|var)\s+[\w$]+\s*=/, 2);
  hit('javascript', /\bfunction\s*\w*\s*\(|=>/, 2);
  hit('javascript', /\b(console\.\w+|document\.|window\.|require\(|module\.exports|export\s+(default|const|function)|import\s.+\sfrom\s+['"])/, 2);
  hit('javascript', /===|!==|;\s*$/m, 1);

  hit('bash', /^#!.*\b(ba|z)?sh\b/, 4);
  hit('bash', /^\s*\$\s+\w/m, 3);
  hit('bash', /^\s*(sudo|cd|ls|echo|export|brew|npm|npx|yarn|pnpm|git|curl|wget|mkdir|rm|cp|mv|grep|chmod|chown|pip3?|python3?|node|defaults|ssh|scp|tar|launchctl|docker|pmset)\s/m, 2);
  hit('bash', /^\s*(open|cat|touch|kill|ps|source)\s/m, 1);
  hit('bash', /(\s\|\s|&&|\s--?[a-z][\w-]*|\$\{?\w+\}?|~\/)/, 1);

  let best = 'plaintext', max = 1;
  for (const k in score) if (score[k] > max) { max = score[k]; best = k; }
  return best;
}
