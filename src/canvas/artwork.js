// dsh-flow canvas — portrait/action artwork lookup for the team inspector.
// Ported from the agent-teams activity panel's artwork module: role keywords
// map to the packaged portraits, with our own chibi set in assets/.

/** Artwork route prefix served by the plugin host half. */
export const ART_BASE = '/dsh-flow/assets/'

/** Role portraits per role keyword. Order matters: the first match wins, so
// specific buckets (qa/建模) come before broad ones (engineer/研究). */
const ROLE_ART = [
  [/data|analys|metric|performance|资料|数据|分析|指标|核对|材料/, 'role-analyst.png'],
  [/论文|writer|docs|spec|撰写|文案|写作|文档|规范|研究|调查|调研/, 'role-researcher.png'],
  [/建模|数学|model|scientific|科学|实验/, 'role-scientist.png'],
  [/\bqa\b|test|verif|quality|验证|审阅|测试|质量/, 'role-qa.png'],
  [/engineer|dev\b|server|backend|\bapi\b|runtime|程序|代码|编程|开发|求解|实现|工程|后端|服务|接口/, 'role-engineer.png'],
  [/design|\bui\b|\bux\b|front|theme|设计|前端|主题|视觉/, 'role-designer.png'],
  [/secur|audit|risk|threat|安全|审计|风险/, 'role-security.png'],
  [/release|\bbuild\b|deploy|\bops\b|\bci\b|发布|构建|部署|运维|协调|调度/, 'role-operator.png'],
  [/队长|captain|lead|拆解|派发|汇总|统筹/, 'role-captain.png'],
]

const CAPTAIN_ART = `${ART_BASE}role-captain.png`

/** Status action artwork per member activity. */
const ACTION_ART = {
  working: `${ART_BASE}action-coding.png`,
  idle: `${ART_BASE}action-sleeping.png`,
  unknown: `${ART_BASE}action-thinking.png`,
}

/**
 * Member portrait URL, or null when no role keyword matches (the caller falls
 * back to the initial-letter avatar).
 */
export function memberArtUrl(name, role) {
  const identity = `${name ?? ''} ${role ?? ''}`.toLowerCase()
  if (/队长|captain|lead|拆解|派发|汇总/.test(identity)) return CAPTAIN_ART
  for (const [pattern, art] of ROLE_ART) {
    if (pattern.test(identity)) return `${ART_BASE}${art}`
  }
  return null
}

export function captainArtUrl() {
  return CAPTAIN_ART
}

/** Action artwork for a member activity ('working' | 'idle' | 'unknown'). */
export function actionArtUrl(activity) {
  return ACTION_ART[activity] ?? ACTION_ART.unknown
}
