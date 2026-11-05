import { z } from 'zod';
import { defineTool, type RegisteredTool } from './registry.ts';

export interface CapabilityFlags {
  llmProvider: string;
  model: string;
  externalTravelSearch: string;
  longTermMemory: string;
  leadCreation: string;
  voice: string;
}

/** Lets the agent answer "can you book / remember / search abroad?" from real configuration. */
export function createSystemStatusTool(flags: CapabilityFlags): RegisteredTool {
  return defineTool({
    name: 'get_system_status',
    description:
      'Report which capabilities are actually connected in this deployment (LLM, external travel search, memory, lead creation, voice, booking). The main capabilities are already listed in your instructions; call this only when the customer asks for detailed system status.',
    inputSchema: z.object({}),
    sideEffect: 'read',
    execute: () => ({
      sourceType: 'system',
      summary: 'capability flags',
      result: { ...flags, onlineBooking: 'not_supported', payments: 'not_supported', messagingSend: 'not_supported' },
    }),
  });
}
