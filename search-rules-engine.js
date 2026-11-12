// SR1 搜尋規則的參考實作（2026-11-11 百科改版；規則來源 android/app/src/test/resources/search_contract.json 的 rules）。
// 用途：Node 檢查腳本用它跑 SR1 案例題與基準題（v2 起含社群段 searchCommunity，伺服器 SQL 與官網社群區照它）；iOS（AdultingGuide/Services/WikiSearchEngine.swift）、Android、官網照同一套演算法實作，
// 三邊用同一批案例比對。演算法的白話說明在 SR1 的 rules.algorithm；這支只做計算、不讀檔、不寫檔。
// 長度一律算 Unicode code point（[...s].length），比對一律逐字（includes），排序同分照分類順序、分類內順序。

const codePoints = (s) => [...s]
const cpLength = (s) => codePoints(s).length

/** 正規化：NFKC（全形轉半形）→ 小寫 → 異體字對照（照 rules.normalize.variants 的順序逐一取代）。 */
export function makeNormalizer(rules) {
  const variants = rules.normalize.variants
  return (value) => {
    let text = String(value ?? '').normalize('NFKC').toLowerCase()
    for (const [from, to] of variants) text = text.split(from).join(to)
    return text
  }
}

/** 依長度由長到短排（同長保留原順序；Array.prototype.sort 是穩定排序）。 */
const longestFirst = (words) => words.map((w, i) => [w, i]).sort((a, b) => cpLength(b[0]) - cpLength(a[0]) || a[1] - b[1]).map(([w]) => w)

const dedupe = (items, key = (x) => x) => {
  const seen = new Set()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 規則裡跟資料無關的部分先算好（正規化後的同義詞組、虛詞、停用詞、分隔字元）。 */
export function compileRules(rules) {
  const norm = makeNormalizer(rules)
  const groups = rules.synonym_groups.map((g) => dedupe(g.map(norm).filter(Boolean)))
  return {
    rules,
    norm,
    groups,
    synonymWords: new Set(groups.flat()),
    fillers: longestFirst(dedupe(rules.fillers.map(norm))),
    separators: new Set(rules.separators),
    stopGrams: new Set(rules.stop_grams.map(norm)),
    hot: rules.hot_searches.map(norm),
    atomicChars: new Set(codePoints(rules.atomic_run_chars ?? '')),
  }
}

/**
 * 內容比對（SR1 v3 definitions.atomic_runs 第 5 點）：逐字包含，而且比對字開頭是英數字時、內容裡緊接在前面的那個字不能是英數字，
 * 比對字結尾是英數字時、緊接在後面的那個字不能是英數字（中文、空白、標點、字頭字尾都算邊界）。
 * 例「etf」不算出現在「netflix」、「0050」不算出現在「0005071」，但「etf定期定額」「買etf」都算。只用在比對文章／貼文欄位，
 * 不用在拆詞時拿詞庫比查詢字（「yubike」照舊拆得出「ubike」）。
 */
export function containsTerm(hay, needle, compiled) {
  if (!hay || !needle) return false
  let at = hay.indexOf(needle)
  if (at < 0) return false
  const atomic = compiled.atomicChars
  const lead = atomic.has(needle[0])
  const trail = atomic.has(needle[needle.length - 1])
  if (!lead && !trail) return true
  // 英數字都是 ASCII（一個 UTF-16 單位），看前後一個單位就夠。
  while (at >= 0) {
    const before = at > 0 ? hay[at - 1] : ''
    const after = hay[at + needle.length] ?? ''
    if (!(lead && atomic.has(before)) && !(trail && atomic.has(after))) return true
    at = hay.indexOf(needle, at + 1)
  }
  return false
}

/**
 * 把一個詞切成「英數段」與「其他段」（SR1 v3 rules.atomic_run_chars：正規化後的 a–z、0–9）：英數段是不可切的整塊，
 * 補救時不切成 2 字片段、也不跟旁邊的中文接成片段（例「etf」不切成 et／tf；「etf定期定額」＝etf＋定期定額）。
 * 回傳 [{ text, atomic }]，順序照原字串。
 */
export function splitAtomicRuns(token, compiled) {
  const runs = []
  for (const ch of codePoints(token)) {
    const atomic = compiled.atomicChars.has(ch)
    const last = runs.at(-1)
    if (last && last.atomic === atomic) last.text += ch
    else runs.push({ text: ch, atomic })
  }
  return runs
}

/** 拆詞：分隔字元切開；4 字以上、而且不是同義詞表裡的整句，先去掉口語虛詞再用空白切；去重；有 2 字以上的詞時丟掉單字詞。 */
export function tokenize(query, compiled) {
  const { norm, separators, fillers, synonymWords, rules } = compiled
  const parts = []
  let current = ''
  for (const ch of codePoints(norm(query))) {
    if (separators.has(ch)) {
      if (current) parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  const pieces = parts.flatMap((part) => {
    if (cpLength(part) < rules.filler_min_part_length || synonymWords.has(part)) return [part]
    let rest = part
    for (const filler of fillers) rest = rest.split(filler).join(' ')
    const split = rest.split(' ').filter(Boolean)
    return split.length ? split : [part]
  })
  const unique = dedupe(pieces)
  return unique.some((t) => cpLength(t) >= 2) ? unique.filter((t) => cpLength(t) >= 2) : unique
}

/** 一個詞的比對字：原詞權重 1；同義詞組裡有一個字「等於」這個詞，整組其他字權重 rules.synonym_weight。 */
export function alternatives(token, compiled) {
  const out = [{ text: token, weight: 1, original: true }]
  for (const group of compiled.groups) {
    if (!group.includes(token)) continue
    for (const word of group) {
      if (!out.some((a) => a.text === word)) out.push({ text: word, weight: compiled.rules.synonym_weight, original: false })
    }
  }
  return out
}

/**
 * 建索引：文章依分類順序、分類內順序攤平；每篇各欄位先正規化。
 * corpus＝{ categories: [{ id, title, articles: [{ id, title, summary, content, tags, eligibility?, how_to?, application_window? }] }] }
 * dailyTitles＝{ 文章 id: [每日一學標題…] }（只有全站搜尋帶）。
 */
export function buildIndex(corpus, compiled, dailyTitles = {}) {
  const { norm, rules } = compiled
  const docs = []
  corpus.categories.forEach((cat, catIndex) => {
    ;(cat.articles ?? []).forEach((a, articleIndex) => {
      const content = rules.content_fields.map((f) => a[f]).filter(Boolean).join('\n')
      docs.push({
        id: a.id,
        categoryId: cat.id,
        catIndex,
        articleIndex,
        fields: {
          title: norm(a.title),
          tags: norm((a.tags ?? []).join(' ')),
          summary: norm(a.summary),
          category: norm(cat.title),
          daily_title: norm((dailyTitles[a.id] ?? []).join(' ')),
          content: norm(content),
        },
      })
    })
  })
  const vocabSources = [
    ...compiled.groups.flat(),
    ...compiled.hot,
    ...corpus.categories.flatMap((c) => splitBy(norm(c.title), rules.category_title_separators)),
    ...corpus.categories.flatMap((c) => (c.articles ?? []).flatMap((a) => (a.tags ?? []).flatMap((t) => norm(t).split(/\s+/u)))),
  ]
  const vocab = longestFirst(dedupe(vocabSources.filter((w) => cpLength(w) >= 2)))
  return { docs, vocab, compiled }
}

function splitBy(text, seps) {
  let parts = [text]
  for (const sep of seps) parts = parts.flatMap((p) => p.split(sep))
  return parts.filter(Boolean)
}

const FIELD_ORDER = ['title', 'tags', 'summary', 'category', 'daily_title', 'content']

/** 一篇文章對一個詞：取最高的「欄位權重×比對字權重」；記下命中的是不是強欄位、是不是原詞。 */
function scoreToken(doc, alts, compiled) {
  const weights = compiled.rules.field_weights
  const strongFields = compiled.rules.strong_fields
  let best = 0
  let strong = false
  let original = false
  for (const alt of alts) {
    for (const field of FIELD_ORDER) {
      if (!containsTerm(doc.fields[field], alt.text, compiled)) continue
      const score = weights[field] * alt.weight
      if (score > best) best = score
      if (strongFields.includes(field)) strong = true
      if (alt.original) original = true
    }
  }
  return { score: best, strong, original }
}

/** 切片補救：這個詞（含同義詞）一篇都比不到、而且 3 字以上，先用詞庫拆，拆不出來再切 2 字片段（濾掉停用片段）。
 * 百科與社群共用：比哪些欄位看 index.fieldOrder（社群索引才有；百科用 FIELD_ORDER），詞庫看 index.vocab。 */
export function rescue(token, index) {
  const { compiled, docs, vocab } = index
  const fields = index.fieldOrder ?? FIELD_ORDER
  const alts = alternatives(token, compiled)
  const hits = docs.some((d) => alts.some((a) => fields.some((f) => containsTerm(d.fields[f], a.text, compiled))))
  if (hits || cpLength(token) < compiled.rules.slice_min_length) return [{ text: token, kind: 'word' }]
  let rest = token
  const found = []
  for (const word of vocab) {
    if (word === token || !rest.includes(word)) continue
    found.push(word)
    rest = rest.split(word).join(' ')
  }
  const minAtomic = compiled.rules.atomic_run_min_length
  if (found.length) {
    // 詞庫拆完剩下的字裡，夠長的英數段當整個詞留著（SR1 v3；例「etf定期定額」拆出「定期定額」後留下「etf」），其餘剩字照舊丟掉。
    const leftovers = splitAtomicRuns(rest, compiled).filter((r) => r.atomic && cpLength(r.text) >= minAtomic && !found.includes(r.text))
    return [...found.map((text) => ({ text, kind: 'vocab' })), ...dedupe(leftovers.map((r) => r.text)).map((text) => ({ text, kind: 'word' }))]
  }
  const size = compiled.rules.slice_size
  const pieces = []
  for (const run of splitAtomicRuns(token, compiled)) {
    if (run.atomic) {
      // 英數段整塊當一個詞（不切）；太短的（1 個字母或數字）丟掉。
      if (cpLength(run.text) >= minAtomic) pieces.push({ text: run.text, kind: 'word' })
      continue
    }
    const chars = codePoints(run.text)
    for (let i = 0; i + size <= chars.length; i += 1) {
      const gram = chars.slice(i, i + size).join('')
      if (!compiled.stopGrams.has(gram)) pieces.push({ text: gram, kind: 'slice' })
    }
  }
  // 一篇都比不到的片段（例：「李限」）與英數段丟掉，不拿來算門檻。
  const useful = dedupe(pieces, (p) => p.text).filter((p) => docs.some((d) => alternatives(p.text, compiled).some((a) => fields.some((f) => containsTerm(d.fields[f], a.text, compiled)))))
  return useful.length ? useful : [{ text: token, kind: 'word' }]
}

/**
 * 搜尋：拆詞 → 切片補救 → 每篇逐詞計分（全部詞命中再加 all_tokens_bonus）→ 全部詞都要命中；沒有就退成至少 ceil(n×fallback_min_ratio) 個詞，
 * 還是沒有、且 fallback_to_single_token 為 true，再退成至少 1 個詞（退過的結果一律放「內文有提到」、命中方式記 partial）。
 * 回傳 { tokens, results: [{ id, categoryId, score, zone }], matchMode, fallback }；zone＝strong（符合）／weak（內文有提到）。
 */
export function search(query, index) {
  const { compiled, docs } = index
  const rules = compiled.rules
  const tokens = dedupe(tokenize(query, compiled).flatMap((t) => rescue(t, index)), (t) => t.text)
  if (!tokens.length) return { tokens: [], results: [], matchMode: 'none', fallback: false }
  const altsByToken = tokens.map((t) => alternatives(t.text, compiled))
  const scored = docs.map((doc) => {
    const perToken = altsByToken.map((alts) => scoreToken(doc, alts, compiled))
    const hitCount = perToken.filter((p) => p.score > 0).length
    const sum = perToken.reduce((acc, p) => acc + p.score, 0)
    return { doc, perToken, hitCount, score: sum + (hitCount === tokens.length ? rules.all_tokens_bonus : 0) }
  })
  const pick = (need) => scored.filter((s) => s.hitCount >= need && s.score > 0)
  let matched = pick(tokens.length)
  let fallback = false
  if (!matched.length && tokens.length > 1) {
    const needs = dedupe([Math.ceil(tokens.length * rules.fallback_min_ratio), ...(rules.fallback_to_single_token ? [1] : [])])
    for (const need of needs) {
      matched = pick(need)
      if (matched.length) break
    }
    fallback = matched.length > 0
  }
  matched.sort((a, b) => b.score - a.score || a.doc.catIndex - b.doc.catIndex || a.doc.articleIndex - b.doc.articleIndex)
  const anySlice = tokens.some((t) => t.kind === 'slice')
  const results = matched.map((s) => {
    const strong = !fallback && !anySlice && s.perToken.every((p) => p.score > 0 && p.strong)
    return { id: s.doc.id, categoryId: s.doc.categoryId, score: s.score, zone: strong ? 'strong' : 'weak', allOriginal: s.perToken.every((p) => p.original) }
  })
  return { tokens, results: results.map(({ allOriginal, ...r }) => r), matchMode: matchMode(results, fallback, anySlice), fallback }
}

function matchMode(results, fallback, anySlice) {
  if (!results.length) return 'none'
  const strong = results.filter((r) => r.zone === 'strong')
  if (fallback || anySlice || !strong.length) return 'partial'
  return strong.some((r) => r.allOriginal) ? 'direct' : 'synonym'
}

/** 搜不到的字要不要存（rules.miss_log）：去頭尾空白後，太長截斷；含連續數字或 @ 就丟掉（回 null）。 */
export function missLogTerm(query, rules) {
  const cfg = rules.miss_log
  const text = String(query ?? '').normalize('NFKC').trim()
  if (!text) return null
  const digitRun = new RegExp(`\\d{${cfg.drop_if_digit_run_at_least},}`, 'u')
  if (digitRun.test(text) || cfg.drop_if_contains.some((c) => text.includes(c))) return null
  return codePoints(text).slice(0, cfg.max_length).join('')
}

// ───────────── 社群（SR1 v2 rules.community；伺服器 community_search_eval、官網社群區照這一段）─────────────

/** 社群比對的欄位（SR1 rules.community.fields 必須正好是這 4 個、這個順序；伺服器 SQL 寫死同一組，check-search-contract 守）。 */
export const COMMUNITY_FIELDS = ['title', 'tags', 'author_name', 'content']

/** 社群詞庫：rules.community.vocab_sources 依序（synonyms＝同義詞字〔組順序〕、hot_searches＝常見搜尋），2 字以上、去重、長的先。 */
export function communityVocab(compiled) {
  const sources = { synonyms: compiled.groups.flat(), hot_searches: compiled.hot }
  const words = compiled.rules.community.vocab_sources.flatMap((name) => sources[name] ?? [])
  return longestFirst(dedupe(words.filter((w) => cpLength(w) >= 2)))
}

/**
 * 建社群索引：posts＝[{ id, title, content, tags?, author_name?, answer_count? }]，陣列順序＝同分時的先後（呼叫端照新到舊排）。
 * 範圍（哪些貼文算一份）由呼叫端決定：App／伺服器是同一個分類（秘技、發問分開），待解答排序再加待解答條件；官網是全部社群貼文。
 */
export function buildCommunityIndex(posts, compiled) {
  const { norm } = compiled
  const docs = posts.map((p, order) => ({
    id: p.id,
    order,
    answerCount: Math.max(0, Math.trunc(Number(p.answer_count) || 0)),
    fields: {
      title: norm(p.title),
      tags: norm((p.tags ?? []).join(' ')),
      author_name: norm(p.author_name),
      content: norm(p.content),
    },
  }))
  return { docs, vocab: communityVocab(compiled), fieldOrder: COMMUNITY_FIELDS, compiled }
}

/** 一篇貼文對一個詞：取最高的「欄位權重×比對字權重」。 */
function scoreCommunityToken(doc, alts, weights, compiled) {
  let best = 0
  for (const alt of alts) {
    for (const field of COMMUNITY_FIELDS) {
      if (containsTerm(doc.fields[field], alt.text, compiled)) best = Math.max(best, weights[field] * alt.weight)
    }
  }
  return best
}

/**
 * 社群搜尋：拆詞、補救（詞庫＝communityVocab、比對範圍＝這份索引）、同義詞與百科同一套；每篇逐詞計分，全部詞命中加 all_tokens_bonus；
 * 門檻同百科（全部 → ceil(n×fallback_min_ratio) → 1 個詞）；allowFallback=false 時只收全部命中（官網：百科已有全中結果時）。
 * 過門檻的再加回答數加分 min(answer_count, answer_bonus_max)。
 * 回傳 { tokens, results: [{ id, hits, score }]（分數高到低 → 索引順序）, fallback }。
 */
export function searchCommunity(query, index, { allowFallback = true } = {}) {
  const { compiled, docs } = index
  const rules = compiled.rules
  const community = rules.community
  // 太長的查詢只看前 max_query_code_points 個字（原字串、正規化之前；伺服器 left() 同一個算法），免得一次搜尋切出上萬個片段。
  const clipped = codePoints(String(query ?? '')).slice(0, community.max_query_code_points).join('')
  const tokens = dedupe(tokenize(clipped, compiled).flatMap((t) => rescue(t, index)), (t) => t.text)
  if (!tokens.length) return { tokens: [], results: [], fallback: false }
  const altsByToken = tokens.map((t) => alternatives(t.text, compiled))
  const scored = docs.map((doc) => {
    const per = altsByToken.map((alts) => scoreCommunityToken(doc, alts, community.field_weights, compiled))
    const hits = per.filter((x) => x > 0).length
    const sum = per.reduce((acc, x) => acc + x, 0)
    return { doc, hits, score: sum + (hits === tokens.length ? rules.all_tokens_bonus : 0) }
  })
  const pick = (need) => scored.filter((s) => s.hits >= need && s.score > 0)
  let matched = pick(tokens.length)
  let fallback = false
  // 社群要 rules.community.fallback_min_tokens 個詞以上才退門檻（站長 2026-11-12：2 個詞兩個都要中，3 個詞以上才退到一半）。
  if (!matched.length && tokens.length >= Math.max(2, community.fallback_min_tokens ?? 2) && allowFallback) {
    // 社群只退到「一半的詞」（SR1 v3 rules.community.fallback_to_single_token＝false，站長 2026-11-11 第五次裁決第 15 項）；百科仍退到 1 個詞。
    const needs = dedupe([Math.ceil(tokens.length * rules.fallback_min_ratio), ...(community.fallback_to_single_token ? [1] : [])])
    for (const need of needs) {
      matched = pick(need)
      if (matched.length) break
    }
    fallback = matched.length > 0
  }
  const results = matched
    .map((s) => ({ id: s.doc.id, order: s.doc.order, hits: s.hits, score: s.score + Math.min(s.doc.answerCount, community.answer_bonus_max) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ order, ...r }) => r)
  return { tokens, results, fallback }
}
