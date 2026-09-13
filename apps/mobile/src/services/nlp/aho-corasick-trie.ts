/**
 * On-device port of ml/nlp/aho_corasick_trie.py's AhoCorasickTrie.
 * Linear-time O(n + m) simultaneous multi-keyword search across multiple
 * Indic scripts (Devanagari, Bengali, Odia) and Romanized code-switching.
 * Lexicon JSON files are bundled as-is from ml/nlp/lexicons/ — same data,
 * no transformation needed since they were already just JSON.
 */

export interface TrieMatch {
  keyword: string;
  start: number;
  end: number;
  category: string;
  language: string;
  weight: number;
  threatDimension: string;
}

interface TrieOutput {
  keyword: string;
  category: string;
  language: string;
  weight: number;
  threatDimension: string;
  length: number;
}

class TrieNode {
  children: Map<string, TrieNode> = new Map();
  fail: TrieNode | null = null;
  outputs: TrieOutput[] = [];
}

function isAlnumAscii(ch: string): boolean {
  return /^[a-z0-9]$/i.test(ch);
}

export class AhoCorasickTrie {
  private root = new TrieNode();
  private isBuilt = false;
  categories = new Set<string>();
  totalPatterns = 0;

  addKeyword(keyword: string, category: string, language: string, weight = 25.0, threatDimension = "LEGAL_THREAT"): void {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return;

    let curr = this.root;
    for (const ch of kw) {
      let next = curr.children.get(ch);
      if (!next) {
        next = new TrieNode();
        curr.children.set(ch, next);
      }
      curr = next;
    }

    if (curr.outputs.some((out) => out.keyword === kw && out.category === category)) return;

    curr.outputs.push({ keyword: kw, category, language, weight, threatDimension, length: kw.length });
    this.categories.add(category);
    this.totalPatterns += 1;
    this.isBuilt = false;
  }

  buildFailureLinks(): void {
    const queue: TrieNode[] = [];

    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }

    let qi = 0;
    while (qi < queue.length) {
      const curr = queue[qi++];
      for (const [ch, child] of curr.children.entries()) {
        queue.push(child);

        let f: TrieNode | null = curr.fail;
        while (f !== null && !f.children.has(ch)) {
          f = f.fail;
        }

        child.fail = f !== null ? f.children.get(ch)! : this.root;
        if (child.fail) child.outputs = child.outputs.concat(child.fail.outputs);
      }
    }

    this.isBuilt = true;
  }

  loadLexicon(data: {
    category?: string;
    threat_dimension?: string;
    weight?: number;
    keywords?: Record<string, string[]>;
  }): void {
    const category = data.category ?? "UNKNOWN";
    const threatDimension = data.threat_dimension ?? "LEGAL_THREAT";
    const weight = typeof data.weight === "number" ? data.weight : 25.0;
    const keywordsDict = data.keywords ?? {};

    for (const [lang, kws] of Object.entries(keywordsDict)) {
      for (const kw of kws) {
        this.addKeyword(kw, category, lang, weight, threatDimension);
      }
    }
  }

  search(text: string): TrieMatch[] {
    if (!this.isBuilt) this.buildFailureLinks();
    if (!text) return [];

    const lowerText = text.toLowerCase();
    const matches: TrieMatch[] = [];
    const seenSpans = new Set<string>();
    let curr: TrieNode | null = this.root;
    const n = lowerText.length;

    for (let i = 0; i < n; i++) {
      const ch = lowerText[i];

      while (curr !== null && !curr.children.has(ch)) {
        curr = curr.fail;
      }

      if (curr === null) {
        curr = this.root;
        continue;
      }

      curr = curr.children.get(ch)!;

      for (const out of curr.outputs) {
        const kwLen = out.length;
        const startIdx = i - kwLen + 1;
        const endIdx = i + 1;

        // Word boundary check for ASCII/Latin characters — prevents e.g.
        // "ed" matching inside "red" or "bed".
        const kw = out.keyword;
        if (kw && isAlnumAscii(kw[0])) {
          if (startIdx > 0 && isAlnumAscii(lowerText[startIdx - 1])) continue;
        }
        if (kw && isAlnumAscii(kw[kw.length - 1])) {
          if (endIdx < n && isAlnumAscii(lowerText[endIdx])) continue;
        }

        const spanKey = `${out.category}|${startIdx}|${endIdx}`;
        if (seenSpans.has(spanKey)) continue;
        seenSpans.add(spanKey);

        matches.push({
          keyword: out.keyword,
          start: startIdx,
          end: endIdx,
          category: out.category,
          language: out.language,
          weight: out.weight,
          threatDimension: out.threatDimension,
        });
      }
    }

    return matches;
  }
}

let sharedTrie: AhoCorasickTrie | null = null;

/** Returns the shared trie, built once from the bundled lexicon JSON files. */
export function getSharedTrie(): AhoCorasickTrie {
  if (!sharedTrie) {
    const trie = new AhoCorasickTrie();
    const lexiconFiles = [
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../../assets/nlp/lexicons/child_custody.json"),
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../../assets/nlp/lexicons/customs_parcel.json"),
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../../assets/nlp/lexicons/digital_arrest.json"),
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../../assets/nlp/lexicons/electricity_cut.json"),
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../../assets/nlp/lexicons/kyc_freeze.json"),
    ];
    for (const lexicon of lexiconFiles) trie.loadLexicon(lexicon);
    trie.buildFailureLinks();
    sharedTrie = trie;
  }
  return sharedTrie;
}
