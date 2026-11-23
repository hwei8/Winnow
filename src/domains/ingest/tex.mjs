// ingest/tex.mjs — 识别"数学宏定义块"
// 有些技术博客把 MathJax/KaTeX 的宏定义直接写在正文 `<pre>` / `<script type="math/tex">` 里，
// 抽取时会当成段落收进来：\newcommand{\pdiv}[3][]{...}、%\DeclareMathOperator* ...、
// \DeclarePairedDelimiters{\ceil}{\lceil}{\rceil}。这类块对"这篇讲什么"没有任何信息量，
// 还会让 claim 抽取与 bench 文本变脏，所以在抽取阶段就该丢掉。

const DEF_CMD = /^\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator\*?|DeclarePairedDelimiters?X?|DeclareRobustCommand|def|let|usepackage|documentclass|begin|end)\b/

/** 该块是不是 LaTeX 宏定义/数学排版噪声 */
export function isLatexNoise (text) {
  const s = String(text ?? '').trim()
  if (!s || !s.includes('\\')) return false
  // `% 注释` 行（LaTeX 注释），正文里几乎不会出现
  if (s.startsWith('%')) return true
  // 以定义类命令开头
  if (DEF_CMD.test(s)) return true
  // 反斜杠 + 花括号密度过高（宏定义体）：正常技术文章里 \$ 或单个 \LaTeX 不会到这个比例
  const slash = (s.match(/\\/g) || []).length
  if (slash >= 3) {
    const braces = (s.match(/[{}]/g) || []).length
    if ((slash * 2 + braces) / s.length > 0.12) return true
  }
  return false
}
