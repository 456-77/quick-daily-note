// ------------------------------------------------------------
// 粘贴代码语言识别
// 基于语法特征打分（关键词 / 结构 / 特殊符号），零依赖、体积小。
// 每条规则命中一次加一次权重（同一规则最多按 2 次命中计），
// 部分规则设有贡献上限 cap，防止单一弱特征反复命中造成误判。
// 得分最高的语言超过阈值即返回，否则返回 null（不干预粘贴）。
// ------------------------------------------------------------

interface LangRule {
  lang: string;
  /** 单次命中权重 */
  weight: number;
  /** 匹配特征的正则 */
  re: RegExp;
  /** 该规则总贡献上限 */
  cap?: number;
}

const RULES: LangRule[] = [
  // ---- JavaScript ----
  { lang: "javascript", weight: 2, re: /=>/g },
  { lang: "javascript", weight: 2, re: /\b(const|let|var)\s+\w+\s*(=|;)/g },
  { lang: "javascript", weight: 3, re: /\bfunction\s*\w*\s*\([^)]*\)\s*\{/g },
  { lang: "javascript", weight: 2, re: /console\.(log|error|warn|info|debug)\s*\(/g },
  { lang: "javascript", weight: 2, re: /\bimport\s+[\s\S]*?\s+from\s+['"]/g },
  { lang: "javascript", weight: 2, re: /\bexport\s+(default\s+)?(function|class|const|let|var)\b/g },
  { lang: "javascript", weight: 2, re: /\bclass\s+\w+\s+(extends|implements)\b/g },
  { lang: "javascript", weight: 1.5, re: /\b(await|async)\b/g },
  { lang: "javascript", weight: 1.5, re: /\.(map|filter|forEach|reduce)\s*\(/g },
  { lang: "javascript", weight: 1.5, re: /\brequire\s*\(/g },
  { lang: "javascript", weight: 1.5, re: /\b(setTimeout|setInterval|Promise)\b/g },
  { lang: "javascript", weight: 1.5, re: /\breturn\s/g },
  { lang: "javascript", weight: 1.5, re: /document\.|window\.|addEventListener\s*\(/g },
  { lang: "javascript", weight: 2, re: /['"][^'"]*['"]\s*:/g },

  // ---- TypeScript ----
  { lang: "typescript", weight: 2.5, re: /\binterface\s+\w+/g },
  { lang: "typescript", weight: 2.5, re: /\btype\s+\w+\s*=/g },
  { lang: "typescript", weight: 2.5, re: /\benum\s+\w+/g },
  { lang: "typescript", weight: 2.5, re: /:\s*(string|number|boolean|void|any|unknown|never)\b/g },
  { lang: "typescript", weight: 2, re: /\b(implements|extends)\s+\w+/g },
  { lang: "typescript", weight: 2, re: /readonly\s+\w+/g },
  { lang: "typescript", weight: 2, re: /\bas\s+(const|string|number|boolean)\b/g },
  { lang: "typescript", weight: 2, re: /\w+\s*\?\s*:\s*\w+/g },
  { lang: "typescript", weight: 2, re: /\bprivate\s+(readonly\s+)?\w+|protected\s+\w+/g },
  { lang: "typescript", weight: 1.5, re: /<[A-Z]\w+>/g },

  // ---- Python ----
  { lang: "python", weight: 3, re: /^\s*def\s+\w+/gm },
  { lang: "python", weight: 3, re: /\bself\./g },
  { lang: "python", weight: 3, re: /^\s*from\s+\w+\s+import\b/gm },
  { lang: "python", weight: 2.5, re: /^\s*import\s+\w+/gm },
  { lang: "python", weight: 2.5, re: /print\s*\(/g },
  { lang: "python", weight: 4, re: /if\s+__name__/g },
  { lang: "python", weight: 2.5, re: /^\s*(if|elif|for|while|with)\b.*:\s*$/gm },
  { lang: "python", weight: 2, re: /^\s*class\s+\w+\s*:/gm },
  { lang: "python", weight: 2, re: /f['"]|\.format\s*\(/g },
  { lang: "python", weight: 1.5, re: /\brange\s*\(|\blen\s*\(/g },
  { lang: "python", weight: 1.5, re: /^\s*pass\s*$/gm },
  { lang: "python", weight: 2, re: /['"][^'"]*['"]\s*:/g },

  // ---- Java ----
  { lang: "java", weight: 5, re: /public\s+static\s+void\s+main/g },
  { lang: "java", weight: 3, re: /System\.(out|err)\.print\w*\s*\(/g },
  { lang: "java", weight: 3, re: /^\s*import\s+(static\s+)?java\./gm },
  { lang: "java", weight: 3, re: /@(Override|Test|Autowired|SpringBootApplication|Entity|Service|Controller|Component)\b/g },
  { lang: "java", weight: 2.5, re: /^\s*(public|private|protected)\s+(static\s+)?[\w<>,\s[\]]+\s+\w+\s*\([^)]*\)\s*\{/gm },
    { lang: "java", weight: 2, re: /\b(?:List|Map|Set|Optional|ArrayList|HashMap|Collection|Iterator|StringBuilder)\s*<[A-Z]\w*(?:\s*,\s*[A-Z]\w*)*>/g },
  { lang: "java", weight: 2, re: /\b(public|private|protected)\s+class\s+\w+/g },
  { lang: "java", weight: 2, re: /String\[\]\s+args/g },

  // ---- C ----
  { lang: "c", weight: 3, re: /#include\s*[<"][\w./-]+[>"]/g },
  { lang: "c", weight: 3, re: /\bint\s+main\s*\(/g },
  { lang: "c", weight: 3, re: /\b(malloc|calloc|realloc|free)\s*\(/g },
  { lang: "c", weight: 2.5, re: /^\s*struct\s+\w+\s*\{/gm },
  { lang: "c", weight: 2.5, re: /printf\s*\(|scanf\s*\(|fprintf\s*\(/g },
  { lang: "c", weight: 2.5, re: /\b(typedef|enum)\s+\w+/g },
  { lang: "c", weight: 2, re: /\bNULL\b|\bFILE\s*\*/g },

  // ---- C++ ----
  { lang: "cpp", weight: 3, re: /#include\s*[<"][\w./-]+[>"]/g },
  { lang: "cpp", weight: 3, re: /\bint\s+main\s*\(/g },
  { lang: "cpp", weight: 4, re: /std::/g },
  { lang: "cpp", weight: 4, re: /cout\s*<<|cin\s*>>/g },
  { lang: "cpp", weight: 3, re: /\btemplate\s*</g },
  { lang: "cpp", weight: 3, re: /\bnullptr\b/g },
  { lang: "cpp", weight: 2.5, re: /\bnamespace\s+\w+\s*\{/gm },
  { lang: "cpp", weight: 2.5, re: /\bclass\s+\w+\s*(:\s*(public|private|protected)\s+\w+)?\s*\{/g },
  { lang: "cpp", weight: 2, re: /\b(public|private|protected):/g },
  { lang: "cpp", weight: 2, re: /\b(typedef|enum)\s+\w+/g },
  { lang: "cpp", weight: 2, re: /^\s*#(define|pragma)/gm },

  // ---- C# ----
  { lang: "csharp", weight: 3.5, re: /^\s*using\s+System\b/gm },
  { lang: "csharp", weight: 4, re: /Console\.(WriteLine|Write|ReadLine|ReadKey)\s*\(/g },
  { lang: "csharp", weight: 3, re: /\bnamespace\s+\w+\s*\{/gm },
  { lang: "csharp", weight: 2.5, re: /\bpublic\s+class\s+\w+/g },
  { lang: "csharp", weight: 2.5, re: /async\s+Task\b|Task<|Task\./g },
  { lang: "csharp", weight: 2.5, re: /\bvar\s+\w+\s*=\s*(new|await)\b/g },
  { lang: "csharp", weight: 2.5, re: /\bstring\s+\w+\s*=\s*"/g },
  { lang: "csharp", weight: 2, re: /^\s*(public|private|protected|internal)\s+static\s+\w+\s+\w+\s*\(/gm },

  // ---- Go ----
  { lang: "go", weight: 4, re: /^\s*package\s+\w+/gm },
  { lang: "go", weight: 4, re: /\bfunc\s+(\w+\s*\(\s*\w+\s*\*\s*\w+\s*\)\s*)?\w*\s*\(/g },
  { lang: "go", weight: 2.5, re: /:=/g },
  { lang: "go", weight: 2.5, re: /\bfmt\.(Println|Printf|Print|Sprintf)\s*\(/g },
  { lang: "go", weight: 2.5, re: /^\s*import\s+"/gm },
  { lang: "go", weight: 2, re: /^\s*import\s*\(/gm },
  { lang: "go", weight: 2, re: /\berr\s*:=\s*\w+\(/g },
  { lang: "go", weight: 2, re: /\bdefer\s+\w+/g },
  { lang: "go", weight: 2, re: /\bgo\s+func\s*\(/g },

  // ---- Rust ----
  { lang: "rust", weight: 4, re: /^\s*fn\s+main\b/gm },
  { lang: "rust", weight: 3, re: /\blet\s+mut\b/g },
  { lang: "rust", weight: 3, re: /\b(println|print|format|vec|dbg|panic)!\s*\(/g },
  { lang: "rust", weight: 3, re: /^\s*use\s+\w+::/gm },
  { lang: "rust", weight: 2.5, re: /^\s*impl\s+\w+/gm },
  { lang: "rust", weight: 2, re: /\bmatch\s+\w+\s*\{/g },
  { lang: "rust", weight: 2, re: /\b(Option|Result|Vec|HashMap)<\w/g },

  // ---- PHP ----
  { lang: "php", weight: 5, re: /<\?php/g },
  { lang: "php", weight: 2.5, re: /\$[a-zA-Z_]\w*/g },
  { lang: "php", weight: 2, re: /\becho\s+/g },
  { lang: "php", weight: 2.5, re: /\bfunction\s+\w+\s*\([^)]*\)\s*\{/g },
  { lang: "php", weight: 2, re: /\b(require_once|include_once|require|include)\s+['"]/g },
  { lang: "php", weight: 2, re: /\bnamespace\s+\w+\\/g },

  // ---- Bash / Shell ----
  { lang: "bash", weight: 4, re: /^#!\s*\/bin\/[a-z]+/gm },
  { lang: "bash", weight: 2, re: /^\s*(sudo|apt(-get)?|yum|dnf|brew|npm|yarn|pnpm|pip|pip3|git|docker|kubectl|curl|wget|systemctl|chmod|chown|mkdir|grep|sed|awk|tar|unzip|make|cmake|node|python3?|deno|bun)\b/gm, cap: 6 },
  { lang: "bash", weight: 2, re: /^\s*(cd|ls|cp|mv|rm|cat|touch|head|tail|find|ps|kill|echo|export|source|alias)\b/gm, cap: 6 },
  { lang: "bash", weight: 1.5, re: /\$\{?\w+}?/g },
  { lang: "bash", weight: 1.5, re: /&&|\|\|/g, cap: 3 },
  { lang: "bash", weight: 2, re: /^\s*\$\s+\w+/gm },

  // ---- PowerShell ----
  { lang: "powershell", weight: 3, re: /\b(Write-Host|Write-Output|Write-Error|Write-Verbose|Write-Warning)\b/g },
  { lang: "powershell", weight: 2.5, re: /\b(Get|Set|New|Remove|Add|Invoke|Test|ConvertTo|ConvertFrom|Import|Export|Restart|Stop|Start|Select|Where|ForEach|Sort|Group)-[A-Z]\w+/g },
  { lang: "powershell", weight: 2.5, re: /\$(PSVersionTable|ErrorActionPreference|Host|PWD|HOME|env:|args|_|PROFILE)\b/g },
  { lang: "powershell", weight: 2.5, re: /\bparam\s*\(/g },
  { lang: "powershell", weight: 2, re: /^\s*[A-Za-z]:\\/gm },

  // ---- Ruby ----
  { lang: "ruby", weight: 3, re: /^\s*def\s+\w+/gm },
  { lang: "ruby", weight: 3, re: /^\s*end\s*$/gm },
  { lang: "ruby", weight: 3, re: /\bputs\s+/g },
  { lang: "ruby", weight: 3.5, re: /\battr_(accessor|reader|writer)\b/g },
  { lang: "ruby", weight: 2.5, re: /(?:^|[^-\w])@[a-z_]\w*/gm },
  { lang: "ruby", weight: 2.5, re: /\s=>\s/g },
  { lang: "ruby", weight: 2, re: /\brequire\s+['"]/g },
  { lang: "ruby", weight: 2, re: /\bdo\s*\|/g },

  // ---- Swift ----
  { lang: "swift", weight: 4, re: /^\s*import\s+(UIKit|Foundation|SwiftUI|Combine|CoreData)\b/gm },
  { lang: "swift", weight: 3.5, re: /\bfunc\s+\w+\s*\([^)]*\)\s*->/g },
  { lang: "swift", weight: 2.5, re: /^\s*let\s+\w+\s*:/gm },
  { lang: "swift", weight: 3.5, re: /\b(guard|if)\s+let\b/g },
  { lang: "swift", weight: 3, re: /@(IBOutlet|IBAction|State|Published|ObservedObject|EnvironmentObject|main)\b/g },
  { lang: "swift", weight: 2, re: /print\s*\(/g },
  { lang: "swift", weight: 2, re: /^\s*class\s+\w+\s*:\s*\w+/gm },

  // ---- Kotlin ----
  { lang: "kotlin", weight: 3.5, re: /^\s*fun\s+main\b/gm },
  { lang: "kotlin", weight: 3, re: /^\s*val\s+\w+\s*[:=]/gm },
  { lang: "kotlin", weight: 2, re: /^\s*var\s+\w+\s*[:=]/gm },
  { lang: "kotlin", weight: 2.5, re: /println\s*\(/g },
  { lang: "kotlin", weight: 3.5, re: /data\s+class\s+\w+/g },
  { lang: "kotlin", weight: 3, re: /override\s+fun\b|private\s+fun\b|fun\s+\w+\s*\(/g },
  { lang: "kotlin", weight: 2.5, re: /companion\s+object|lateinit\s+var|when\s*\(/g },
  { lang: "kotlin", weight: 2.5, re: /\w+\.\s*(let|apply|also|run|with)\s*\{/g },

  // ---- Dart ----
  { lang: "dart", weight: 3.5, re: /^\s*void\s+main\b/gm },
  { lang: "dart", weight: 4, re: /import\s+['"]package:/g },
  { lang: "dart", weight: 2.5, re: /\bclass\s+\w+\s+extends\s+\w+/g },
  { lang: "dart", weight: 2, re: /\bfinal\s+\w+\s*=/g },
  { lang: "dart", weight: 2, re: /print\s*\(/g },

  // ---- Lua ----
  { lang: "lua", weight: 3.5, re: /^\s*local\s+function/gm },
  { lang: "lua", weight: 3, re: /\btable\.(insert|remove|concat|unpack|pack)\s*\(/g },
  { lang: "lua", weight: 3, re: /\b(ipairs|pairs|next)\s*\(/g },
  { lang: "lua", weight: 2.5, re: /^\s*end\s*$/gm },
  { lang: "lua", weight: 2, re: /^\s*--/gm },
  { lang: "lua", weight: 2, re: /\brequire\s+['"]/g },
  { lang: "lua", weight: 2, re: /\blocal\s+\w+\s*=/g },
  { lang: "lua", weight: 2, re: /print\s*\(/g },

  // ---- R ----
  { lang: "r", weight: 4, re: /library\s*\(/g },
  { lang: "r", weight: 3.5, re: /(?<!<)<-/g },
  { lang: "r", weight: 4, re: /%>%/g },
  { lang: "r", weight: 3.5, re: /\bggplot\s*\(|aes\s*\(/g },
  { lang: "r", weight: 3, re: /\bread\.\w+|\bwrite\.\w+/g },
  { lang: "r", weight: 2, re: /\b(mean|median|summary|sd|var|lm|t\.test)\s*\(/g },

  // ---- SQL ----
  { lang: "sql", weight: 3, re: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT)\b/gi },
  { lang: "sql", weight: 2, re: /\b(FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|JOIN|UNION)\b/gi },
  { lang: "sql", weight: 2.5, re: /\b(VARCHAR|INTEGER|TIMESTAMP|DATETIME|PRIMARY\s+KEY|FOREIGN\s+KEY|NOT\s+NULL|AUTO_INCREMENT)\b/gi },
  { lang: "sql", weight: 2, re: /\bINTO\s+\w+|\bVALUES\s*\(/gi },

  // ---- HTML ----
  { lang: "html", weight: 4, re: /<!DOCTYPE\s+html>/gi },
  { lang: "html", weight: 3, re: /<html[^>]*>|<\/html>/gi },
  { lang: "html", weight: 2.5, re: /<\/(div|span|p|a|ul|ol|li|table|thead|tbody|tr|td|th|button|form|nav|header|footer|section|article|script|body|head)\b>/gi },
  { lang: "html", weight: 2, re: /<(div|span|p|a|img|ul|ol|li|table|tr|td|button|input|form|nav|header|footer|section|article|script|h[1-6]|br|meta|link|head|body)[\s>]/gi },
  { lang: "html", weight: 2, re: /class="[^"]*"|id="[^"]*"|href="|src="/g },
  { lang: "html", weight: 2, re: /&(nbsp|amp|lt|gt|quot);/g },
  { lang: "html", weight: 1.5, re: /<\/?\w+[^>]*>/g },

  // ---- CSS ----
  { lang: "css", weight: 3, re: /^\s*[.#][a-zA-Z][\w-]*([.#:][\w-]+)*\s*\{/gm },
  { lang: "css", weight: 2, re: /^\s*[a-zA-Z-]+\s*:\s*[^;{}]+;\s*$/gm },
  { lang: "css", weight: 2.5, re: /@media|@keyframes|@import|@font-face|@supports|@charset/g },
  { lang: "css", weight: 2, re: /:\s*\d+(\.\d+)?(px|em|rem|vh|vw|vmin|vmax|%|s|ms|fr)\b|!important|#[0-9a-fA-F]{3,8}\b/g },
  { lang: "css", weight: 1.5, re: /^\s*(html|body|\*)\s*\{/gm },
  { lang: "css", weight: 1.5, re: /\b(display|margin|padding|color|background|border|flex|grid|position|width|height|font-size)\s*:/gi },

  // ---- JSON 之外的常见配置格式 ----
  // 扁平 key: value 对单独出现时可能只是普通文本（如联系人信息），
  // 设置 cap 使其不足以单独触发，需与其他 YAML 特征（嵌套/列表/---）组合。
  { lang: "yaml", weight: 1.5, re: /^\s*[a-zA-Z_][\w-]*\s*:\s+\S|^\s*[a-zA-Z_][\w-]*\s*:\s*$/gm, cap: 3 },
  { lang: "yaml", weight: 1.2, re: /^\s*-\s+\S/gm, cap: 2 },
  { lang: "yaml", weight: 2.5, re: /^\s*---\s*$/gm },
  { lang: "yaml", weight: 1.5, re: /^\s{2,}[a-zA-Z_][\w-]*\s*:\s+\S/gm },
  { lang: "yaml", weight: 2, re: /["'][^"']*["']\s*:/g },

  { lang: "toml", weight: 2.5, re: /^\s*\[[a-zA-Z0-9_.-]+\]\s*$/gm },
  { lang: "toml", weight: 2, re: /^\s*[a-zA-Z][\w-]*\s*=\s*"/gm },
  { lang: "toml", weight: 1.5, re: /^\s*[a-zA-Z][\w-]*\s*=\s*\d/gm },
  { lang: "toml", weight: 1.5, re: /^\s*[a-zA-Z][\w-]*\s*=\s*(true|false)\s*$/gm },
  { lang: "ini", weight: 2, re: /^\s*\[[a-zA-Z0-9_.-]+\]\s*$/gm },
  { lang: "ini", weight: 2, re: /^\s*[a-zA-Z][\w-]*\s*=\s*\S+\s*$/gm },

  // ---- Diff / Dockerfile / LaTeX ----
  { lang: "diff", weight: 4, re: /^diff --git|^index\s+[0-9a-f]{7,}/gm },
  { lang: "diff", weight: 3.5, re: /^@@\s*[-+0-9, ]+@@/gm },
  { lang: "diff", weight: 2.5, re: /^[+-][^+-\s]/gm, cap: 5 },
  { lang: "diff", weight: 2, re: /^\+\+\+\s|^---\s/gm },

  { lang: "dockerfile", weight: 3, re: /^\s*(FROM|RUN|CMD|ENTRYPOINT|COPY|ADD|WORKDIR|ENV|EXPOSE|ARG|LABEL|VOLUME|USER|HEALTHCHECK)\b/gm },

  { lang: "latex", weight: 3, re: /\\(documentclass|usepackage|begin|end|section|subsection|chapter|item|textbf|textit|frac|label|ref|cite|includegraphics|table|figure|tabular|itemize|enumerate|alpha|beta)\b/g },
  { lang: "latex", weight: 2, re: /\\[a-zA-Z]+\{[^}]*\}/g },
  { lang: "latex", weight: 1.5, re: /\$[^$\n]*\$/g },

  // ---- XML ----
  { lang: "xml", weight: 4, re: /<\?xml/g },
  { lang: "xml", weight: 3, re: /xmlns(:\w+)?=/g },
  { lang: "xml", weight: 2, re: /<\/\w+>/g },
  { lang: "xml", weight: 1.5, re: /<!DOCTYPE\s+\w+/gi },

  // ---- Mermaid ----
  { lang: "mermaid", weight: 5, re: /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|requirementDiagram|quadrantChart|sankey-beta|block-beta|architecture-beta|xyChart)\b/m },
  { lang: "mermaid", weight: 3, re: /^\s*[A-Za-z0-9_()"']+\s*(-->|---|==>|-\.->|--x|--o|==|-.->)\s*[A-Za-z0-9_()"']/m, cap: 6 },
];

/** 整段可解析的 JSON 直接判定；无法解析时按引号键数量打分 */
function tryJson(text: string): number {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return 0;
  if (t.endsWith("}") || t.endsWith("]")) {
    try {
      JSON.parse(t);
      return 10;
    } catch {
      // 继续按特征打分
    }
  }
  const keys = (t.match(/"\w+"\s*:/g) ?? []).length;
  return Math.min(keys, 3) * 2;
}

/**
 * 识别文本的编程语言。得分最高的语言达到阈值时返回语言名（Obsidian
 * 代码块语言标识），否则返回 null。多行阈值 4，单行阈值 4.5（单行仅在
 * 特征非常明确时才会被当作代码处理，避免误伤普通文字）。
 */
export function detectLanguage(text: string, multiLine: boolean): string | null {
  const scores = new Map<string, number>();

  for (const rule of RULES) {
    const matches = text.match(rule.re);
    if (!matches) continue;
    const contribution = Math.min(rule.weight * Math.min(matches.length, 2), rule.cap ?? Infinity);
    if (contribution > 0) {
      scores.set(rule.lang, (scores.get(rule.lang) ?? 0) + contribution);
    }
  }

  const jsonScore = tryJson(text);
  if (jsonScore > 0) {
    scores.set("json", Math.max(scores.get("json") ?? 0, jsonScore));
  }

  let best = "";
  let bestScore = 0;
  for (const [lang, score] of scores) {
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }

  const threshold = multiLine ? 4 : 4.5;
  return bestScore >= threshold ? best : null;
}
