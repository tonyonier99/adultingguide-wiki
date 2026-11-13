// 官網搜尋頁的畫面與事件（1.5）。產生網站時複製成 /search-page.js（module script）。
// 結果分「符合」「內文有提到」「社群」「合作」；零結果三塊（PLAN 3.3）；送 search_complete（PLAN 6.2），不送搜尋字。
// 常見搜尋只在輸入框（去掉前後空白）是空的時候顯示，打了字就收起、清空再出現（照 App WikiSearchResultsPage；站長第五次裁決第 10 項）。
// 一次搜尋只送一筆（AE1 definitions.search_session）：點結果、零結果頁點大家都在看或許願、清空輸入、離開頁面（pagehide／切到背景）
// 時送這次最後一個不在組字中的狀態；改字、點常見搜尋（＝開始新的一次）、按搜尋鍵都不算結束；同一串字從結果返回後不重送。
// 刪字（AE1 v11 search_session.deleting）：放棄送刪之前已結算那串字（state），其他結束動作送畫面上那串字與它的結果（onScreen）；
// 返回還原用的 history 一律存畫面上的字（事件口徑與畫面狀態分開存，ACCEPTANCE-E3 二-2）。
// 搜不到的字（SR1 rules.miss_log）：只有產生網站時給了公開 anon key（D.missLog）才送，送前用 SR1 參考實作 missLogTerm 過濾。
import * as engine from '/search-rules-engine.js'
import { bucketCount, bucketLen, bucketRank, createWebSearch, isDeletingFrom } from '/search-web.js'

const D = window.AG_SEARCH_DATA
const input = document.getElementById('q')
const out = document.getElementById('results')
const form = document.querySelector('.s5-form')
const hot = document.querySelector('.v5-hot')
let search = null
let state = { q: '', r: null, sent: true }   // 這次搜尋已結算那串字（刪字不覆蓋；放棄送它）
let onScreen = { q: '', r: null }   // 畫面上那串字與它的結果（點結果、零結果動作送它；返回還原它）
let timer = null
let composing = false

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function mark(text, words) {
  let html = esc(text)
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    if (w) html = html.replace(new RegExp(reEsc(esc(w)), 'gi'), (m) => `<mark>${m}</mark>`)
  }
  return html
}

function remember(q, sentQ) {
  try { history.replaceState({ agq: q, agsent: sentQ }, '', location.pathname + location.hash) } catch (e) { /* 只影響返回時還原 */ }
}

function logMiss(q) {
  const term = D.missLog && engine.missLogTerm(q, D.rules)
  if (!term) return
  fetch(D.missLog.url, {
    method: 'POST', keepalive: true,
    headers: { apikey: D.missLog.key, Authorization: `Bearer ${D.missLog.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_term: term, p_scope: 'all', p_platform: 'web' }),
  }).catch(() => { /* 記不到就算了，不影響搜尋 */ })
}

function send(outcome, rank) {
  const s = outcome === 'abandon' ? state : onScreen
  if (state.sent || !s.q || !s.r) return
  state = { ...s, sent: true }
  remember(onScreen.q, onScreen.q)
  if (!s.r.total) logMiss(s.q)
  if (typeof window.gtag !== 'function') return
  const r = s.r
  const params = {
    scope: 'all', has_result: r.total ? 'true' : 'false', result_bucket: bucketCount(r.total), match_mode: r.mode,
    query_len_bucket: bucketLen([...s.q].length), outcome,
  }
  if (rank) params.tapped_rank = bucketRank(rank)
  window.gtag('event', 'search_complete', params)
}

function card(x, kind, words, rank) {
  const label = kind === 'post' ? `社群・${esc(x.s || '討論')}` : kind === 'promo' ? '合作' : `百科・${esc(x.c)}`
  return `<a class="s5-card" href="${esc(x.u)}" data-rank="${rank}"><small>${label}</small><b>${mark(x.t, words)}</b><p>${mark(x.d, words)}</p></a>`
}

const fill = (template, count) => template.replace('{count}', String(count))

/** head：SC1 句子拆成的［標題, 「{count} 篇」］（site_v2_wiki_copy.split_count）。 */
function group(head, list, kind, words, start, limit = list.length) {
  if (!list.length) return ''
  const more = list.length > limit ? `<p class="s5-sum">${esc(fill(D.copy.postMore, limit))}</p>` : ''
  const cards = list.slice(0, limit).map((x, i) => card(x, kind, words, start + i + 1)).join('')
  return `<div class="s5-grp"><h2>${esc(head[0])}<span>${esc(fill(head[1], list.length))}</span></h2><div class="s5-list">${cards}</div>${more}</div>`
}

function zero(q) {
  const top = D.popular.map((a) => `<li><a href="${esc(a.u)}" data-zero="popular">${esc(a.t)}</a></li>`).join('')
  return `<div class="s5-zero"><div class="s5-box"><h2>${esc(D.copy.zeroTitle.replace('{query}', q))}</h2><p>${esc(D.copy.zeroTip)}</p></div>` +
    (top ? `<div class="s5-box"><h2>${esc(D.copy.popularTitle)}</h2><ol>${top}</ol></div>` : '') +
    `<div class="s5-box s5-wish"><h2>${esc(D.copy.wishTitle)}</h2><p>${esc(D.copy.wishBody)}</p>` +
    `<a class="btn" href="feedback" data-zero="wish">${esc(D.copy.wishButton)}</a></div></div>`
}

/** 常見搜尋：跟著輸入框即時收起／出現（不等 250 毫秒，同 App 隨字變）。 */
function syncHot() {
  if (hot) hot.hidden = input.value.trim() !== ''
}

function render() {
  syncHot()
  if (composing) return
  const q = input.value.trim()
  // 刪字：保留刪之前那串字的狀態（AE1 search_session.deleting，放棄時送它）；畫面與 onScreen 跟著剩下那串字。
  const deleting = !state.sent && Boolean(state.r) && isDeletingFrom(state.q, q)
  if (q !== state.q && !deleting) {
    if (!q) send('abandon')
    state = { q, r: null, sent: Boolean(q) && history.state?.agsent === q }
  }
  remember(q, state.sent ? q : '')
  onScreen = { q, r: null }
  if (!q) { out.innerHTML = ''; return }
  if (!search) { out.innerHTML = '<p class="s5-sum">搜尋中…</p>'; return }
  const r = search.search(q)
  onScreen = { q, r }
  if (!deleting) state.r = r
  if (!r.total) { out.innerHTML = zero(q); return }
  const words = r.tokens.map((t) => t.text)
  const shown = words.length && words.join('') !== q.toLowerCase() ? `（找的是：${words.map(esc).join('、')}）` : ''
  const n1 = r.match.length
  const n2 = n1 + r.body.length
  const n3 = n2 + Math.min(r.posts.length, D.postLimit)
  out.innerHTML = `<p class="s5-sum">「${esc(q)}」${shown}</p>` +
    group(D.copy.strong, r.match, 'article', r.marks, 0) + group(D.copy.weak, r.body, 'article', r.marks, n1) +
    group(D.copy.community, r.posts, 'post', r.marks, n2, D.postLimit) + group(D.copy.promo, r.promos, 'promo', r.marks, n3)
}

async function load(path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return res.json()
}

out.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a')
  if (!a) return
  if (a.dataset.rank) send('result', Number(a.dataset.rank))
  else if (a.dataset.zero === 'popular') send('zero_popular')
  else if (a.dataset.zero === 'wish') send('zero_wish')
})
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('.v5-hot a')
  if (!a) return
  e.preventDefault()
  input.value = new URL(a.href).searchParams.get('q') || ''
  render()
})
form.addEventListener('submit', (e) => { e.preventDefault(); render() })
input.addEventListener('input', () => { syncHot(); clearTimeout(timer); timer = setTimeout(render, 250) })
input.addEventListener('compositionstart', () => { composing = true })
input.addEventListener('compositionend', () => { composing = false; clearTimeout(timer); timer = setTimeout(render, 250) })
window.addEventListener('pagehide', () => send('abandon'))
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send('abandon') })

input.value = window.__agSearchQ || ''
render()
// 索引與內文一起抓：比對要用到內文（SR1 第 3、5 條），內文沒到之前不出結果，免得先出一份跟 App 不同的結果。
Promise.all([load('/search-index.json'), load('/search-body.json')])
  .then(([entries, bodies]) => { search = createWebSearch(engine, D.rules, entries, bodies); render() })
  .catch(() => { out.innerHTML = '<p class="s5-sum">搜尋索引載入失敗，請重新整理。</p>' })
