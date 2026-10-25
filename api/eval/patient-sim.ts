import type Anthropic from '@anthropic-ai/sdk';
import type { Scenario } from './types.js';

export const SIMULATOR_MODEL = 'claude-haiku-5-5';
export const DONE = 'DONE';

/** A simulated patient: writes the next WhatsApp message toward the scenario's goal. */
export async function nextPatientMessage(
  client: Anthropic,
  scenario: Scenario,
  transcript: { from: 'patient' | 'clinic'; text: string }[],
): Promise<{ text: string; costMicroUsd: number }> {
  const persona = scenario.persona!;
  const language =
    scenario.lang === 'ar' ? 'Saudi Arabic (Gulf dialect is fine)' : 'English';
  const system = `You are role-playing a patient chatting on WhatsApp with the assistant of a dental clinic in Riyadh. Today is Sunday 2026-10-25.
Your goal: ${persona.goal}
Your style: ${persona.style}
Rules:
- Write only your next message to the clinic, 1-2 short sentences, in ${language}.
- Answer the assistant's questions using your goal; if it offers options that fit your goal, pick one.
- When the clinic shows a confirmation card, a separate system presses the buttons for you; just wait for the result.
- Reply with exactly ${DONE} when your goal is done (the clinic said it is booked/changed/cancelled after the card), or clearly impossible.`;
  const messages: Anthropic.MessageParam[] = transcript.length
    ? transcript.map((t) => ({
        role: t.from === 'patient' ? ('assistant' as const) : ('user' as const),
        content: t.text,
      }))
    : [];
  if (!messages.length || messages[0].role === 'assistant')
    messages.unshift({
      role: 'user',
      content: '(The chat is open. Send your first message.)',
    });
  if (messages.at(-1)!.role === 'assistant')
    messages.push({ role: 'user', content: '(No reply yet.)' });

  const response = await client.messages.create({
    model: SIMULATOR_MODEL,
    max_tokens: 1000,
    output_config: { effort: 'low' },
    system,
    messages,
  });
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const u = response.usage;
  return {
    text,
    costMicroUsd: Math.round(u.input_tokens * 0.1 + u.output_tokens * 0.5),
  };
}
