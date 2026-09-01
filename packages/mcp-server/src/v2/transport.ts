import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './server.js';

export async function serveStdio(rootDir = process.cwd()): Promise<void> {
  const server = buildMcpServer(rootDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
