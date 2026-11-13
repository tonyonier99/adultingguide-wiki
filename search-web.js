// 官網站內搜尋的膠水層（1.5，PLAN 第三節）。比對規則與演算法一律用 SR1 的參考實作
// （Scripts/search-rules-engine.mjs，產生網站時原檔複製成 search-rules-engine.js），這支不重寫比對邏輯，只做：
//   1. 把官網搜尋索引（search-index.json＋search-body.json）轉成參考實作吃的語料（分類順序、分類內順序照索引順序）。
//   2. 官網混排頁（SR1 definitions.web_mixed_page W1～W4）：
//      社群＝參考實作 searchCommunity（rules.community：拆詞、補救、英數段、欄位權重、只退到一半的詞、回答數加分；
//      官網索引只有標題與內文前 120 字，沒有標籤與作者），百科全中時只收全部命中（mixed_page_strict_when_wiki_full_match）。
//      合作＝rules.web_promo：沿用百科那次拆出來的詞，欄位權重、門檻、百科全中時只收全中都讀 SR1，這裡不另寫數字。
//   3. search_complete 的級距（PLAN 6.2）。
// 參考實作用參數傳進來（createWebSearch(engine, …)），瀏覽器與 Node 測試都能用。
const CONTENT_KEYS = ['content', 'eligibility', 'how_to', 'application_window']

/** 索引 → 參考實作的語料：{ categories: [{ id, title, articles }] }、每日一學標題 { 文章 id: [標題] }。 */
export function corpusFromIndex(entries, bodies) {
  const categories = []
  const byTitle = new Map()
  const dailyTitles = {}
  const articleByUrl = new Map()
  for (const e of entries) {
    if (e.k !== '百科') continue
    if (!byTitle.has(e.c)) {
      const cat = { id: e.c, title: e.c, articles: [] }
      byTitle.set(e.c, cat)
      categories.push(cat)
    }
    const body = (bodies && bodies[e.i]) || {}
    const article = { id: e.i, title: e.t, summary: e.d, tags: e.g || [] }
    for (const key of CONTENT_KEYS) if (body[key]) article[key] = body[key]
    byTitle.get(e.c).articles.push(article)
    articleByUrl.set(e.u, e)
  }
  for (const e of entries) {
    const parent = e.k === '每日一學' && articleByUrl.get(e.u)
    if (parent) (dailyTitles[parent.i] ||= []).push(e.t)
  }
  return { corpus: { categories }, dailyTitles }
}

function scoreOther(doc, altsByToken, rules) {
  const promo = rules.web_promo
  let hits = 0
  let total = 0
  for (const alts of altsByToken) {
    let best = 0
    for (const alt of alts) {
      for (const field of promo.fields) {
        if (doc.fields[field].includes(alt.text)) best = Math.max(best, promo.field_weights[field] * alt.weight)
      }
    }
    if (best > 0) hits += 1
    total += best
  }
  return { hits, score: total + (hits === altsByToken.length ? rules.all_tokens_bonus : 0) }
}

/** 合作（SR1 rules.web_promo、definitions.web_mixed_page W3）：用百科那次搜尋拆出來的詞（含補救、同義詞），
 * 門檻全部 → 一半 →（fallback_to_single_token 時）1 個詞；百科全中時只收全部命中（strict_when_wiki_full_match）。
 * 排序分數高到低 → 索引順序。 */
function rankPromos(docs, altsByToken, rules, wikiFullMatch) {
  if (!altsByToken.length) return []
  const promo = rules.web_promo
  const scored = docs.map((doc) => ({ doc, ...scoreOther(doc, altsByToken, rules) }))
  const strict = promo.strict_when_wiki_full_match && wikiFullMatch
  const fallbacks = strict ? [] : [Math.ceil(altsByToken.length * rules.fallback_min_ratio), ...(promo.fallback_to_single_token ? [1] : [])]
  for (const need of [...new Set([altsByToken.length, ...fallbacks])]) {
    const picked = scored.filter((s) => s.hits >= need && s.score > 0)
    if (picked.length) {
      return picked.sort((a, b) => b.score - a.score || a.doc.order - b.doc.order).map((s) => s.doc.entry)
    }
  }
  return []
}

export function createWebSearch(engine, rules, entries, bodies) {
  const compiled = engine.compileRules(rules)
  const { corpus, dailyTitles } = corpusFromIndex(entries, bodies)
  const index = engine.buildIndex(corpus, compiled, dailyTitles)
  const byId = new Map(entries.filter((e) => e.k === '百科').map((e) => [e.i, e]))
  const promo = rules.web_promo
  const promos = entries.map((entry, order) => ({ entry, order })).filter((x) => x.entry.k === '合作')
    .map((x) => ({ ...x, fields: Object.fromEntries(promo.fields.map((f) => [f, compiled.norm(x.entry[promo.index_fields[f]])])) }))
  // 社群索引：陣列順序＝索引順序（同分時的先後）；官網沒有標籤、作者欄，回答數是 n。
  const postEntries = entries.filter((e) => e.k === '社群')
  const postIndex = engine.buildCommunityIndex(postEntries.map((e, i) => ({ id: i, title: e.t, content: e.d, answer_count: e.n })), compiled)

  function search(query) {
    const r = engine.search(query, index)
    const altsByToken = r.tokens.map((t) => engine.alternatives(t.text, compiled))
    const strong = r.results.filter((x) => x.zone === 'strong').map((x) => byId.get(x.id))
    const weak = r.results.filter((x) => x.zone === 'weak').map((x) => byId.get(x.id))
    // 「百科全中」＝百科有結果而且沒有退門檻（SR1 definitions.web_mixed_page W1）。
    const wikiFullMatch = r.results.length > 0 && !r.fallback
    const strict = rules.community.mixed_page_strict_when_wiki_full_match && wikiFullMatch
    const community = engine.searchCommunity(query, postIndex, { allowFallback: !strict })
    const postHits = community.results.map((x) => postEntries[x.id])
    const promoHits = rankPromos(promos, altsByToken, rules, wikiFullMatch)
    const total = r.results.length + postHits.length + promoHits.length
    // 命中方式照 SR1 第 9 條（只看百科）；百科沒有、只有社群或合作時記 direct（web_mixed_page W4，站長第五次裁決第 31 項）。
    const mode = r.results.length ? r.matchMode : total ? 'direct' : 'none'
    const communityAlts = community.tokens.map((t) => engine.alternatives(t.text, compiled))
    const marks = [...new Set([...altsByToken, ...communityAlts].flat().map((a) => a.text))]
    return { tokens: r.tokens, marks, mode, order: r.results.map((x) => x.id), match: strong, body: weak, posts: postHits, promos: promoHits, total }
  }

  return { search }
}

export const bucketCount = (n) => (n <= 0 ? '0' : n === 1 ? '1' : n <= 5 ? '2_5' : n <= 20 ? '6_20' : '21_plus')
export const bucketLen = (n) => (n <= 1 ? '1' : n === 2 ? '2' : n === 3 ? '3' : n <= 6 ? '4_6' : '7_plus')
export const bucketRank = (n) => (n <= 3 ? String(n) : n <= 10 ? '4_10' : '11_plus')

/**
 * 刪字（AE1 v10 definitions.search_session.deleting，站長 2026-11-13 照建議）：新字串是已結算那串的前綴、比較短＝保留刪之前那串字的狀態，
 * 不換成剩下的字；字被刪光仍送 abandon（送的是刪之前那串字）、打新字（不是前綴縮短）才換。同 App SearchSessionTracker。
 */
export const isDeletingFrom = (settledQuery, q) => Boolean(q && settledQuery) && q.length < settledQuery.length && settledQuery.startsWith(q)
