import type Anthropic from '@anthropic-ai/sdk';
import { userPrompt, pageLabels } from './omrPrompt';
import { sniffImage, OmrUserError, type OmrRequest } from './omrCore';

/**
 * The user message for one reading: every image with its page label, then the instructions.
 * A second look (`followUp`) is the same message with one more text block, so the system prompt and the images
 * (the expensive part) are read from the prompt cache instead of being paid for twice.
 */
export function buildContent(req: OmrRequest, followUp?: string): Anthropic.ContentBlockParam[] {
  const labels = pageLabels(req.images.length, req.tiles);
  const content: Anthropic.ContentBlockParam[] = [];
  req.images.forEach((url, i) => {
    const media = sniffImage(url);
    if (!media) throw new OmrUserError('One of the images could not be opened. Try taking the photo again.');
    content.push({ type: 'text', text: labels[i] });
    const block: Anthropic.ImageBlockParam = { type: 'image', source: { type: 'base64', media_type: media, data: url.slice(url.indexOf(',') + 1) } };
    if (i === req.images.length - 1) block.cache_control = { type: 'ephemeral' };
    content.push(block);
  });
  content.push({ type: 'text', text: userPrompt(req.tiles?.length ?? req.images.length, req.hints) });
  if (followUp) content.push({ type: 'text', text: followUp });
  return content;
}
