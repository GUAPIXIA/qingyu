// 外部 Agent 的 MCP 注册描述（方案 §3：启动和连接描述由工具包生成）。
// 不写入任何 PC 产品配置；用户不需要在轻语里启用新功能。
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MCP_SERVER_PATH = resolve(HERE, 'mcp-server.mjs')
export const SERVER_KEY = 'qingyu-pc-agent'

export const CLIENTS = ['generic', 'codex', 'claude']

export function mcpConfig(client = 'generic') {
  if (!CLIENTS.includes(client)) {
    const error = new Error(`未知客户端：${client}（可用：${CLIENTS.join(' / ')}）`)
    error.code = 'BAD_USAGE'
    throw error
  }

  const server = { command: 'node', args: [MCP_SERVER_PATH] }
  const notes = [
    '工作目录无关：mcp-server 使用绝对路径定位仓库，可从任意目录启动。',
    'MCP server 与 CLI 共用同一个 Session Host 与动作目录，不存在第二套执行逻辑。',
    '日志走 stderr；stdout 只输出 MCP 协议消息，不打印令牌。',
  ]

  if (client === 'codex') {
    const toml = `# ~/.codex/config.toml（或项目级配置）
[mcp_servers.${SERVER_KEY}]
command = "node"
args = ["${MCP_SERVER_PATH.replace(/\\/g, '\\\\')}"]
`
    return { client, server, text: `${toml}\n${notes.map((note) => `# ${note}`).join('\n')}\n`, notes, configPath: '~/.codex/config.toml' }
  }

  const json5 = {
    mcpServers: {
      [SERVER_KEY]: server,
    },
  }
  const configPath = client === 'claude' ? 'claude_desktop_config.json' : '.mcp.json（项目级）或客户端 MCP 配置'
  return {
    client,
    server,
    configPath,
    json: json5,
    text: `${JSON.stringify(json5, null, 2)}\n\n${notes.map((note) => `// ${note}`).join('\n')}\n`,
    notes,
  }
}
