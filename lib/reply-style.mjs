// These are adjustable prototype rules, not a personality assessment.
const WINDOW_SIZE = 5;

const GUIDANCE = {
  brief: 'Usually use 1-3 short sentences, roughly 15-55 words. There is no minimum length.',
  balanced: 'Usually use one short paragraph, roughly 40-90 words. Stop sooner when the answer is complete.',
  expanded: 'Allow 2-3 short paragraphs, roughly 80-160 words, when the question benefits from explanation. Do not add filler.'
};

export function wordCount(value) {
  if (typeof value !== 'string') return 0;
  return (value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
}

export function replyStyle(session, action = 'open', userText = '') {
  // Only messages recorded by the server as typed by the participant count.
  // Button requests, model replies and work samples are not style evidence.
  const typedMessages = (session.messages || [])
    .filter(message => message.role === 'user' && message.source === 'typed')
    .map(message => message.content);

  // The current message is not stored until generation succeeds, so include it here.
  const currentMessage = action === 'say' ? [userText] : [];
  const counts = [
    ...(session.answers || []),
    ...typedMessages,
    ...currentMessage
  ]
    .map(wordCount)
    .filter(count => count > 0)
    .slice(-WINDOW_SIZE)
    .sort((a, b) => a - b);

  if (counts.length === 0) {
    return { mode: 'balanced', instruction: GUIDANCE.balanced, medianWords: 0, sampleSize: 0 };
  }

  // A median reduces the influence of one unusually short or long message.
  const middle = Math.floor(counts.length / 2);
  const medianWords = counts.length % 2
    ? counts[middle]
    : (counts[middle - 1] + counts[middle]) / 2;

  const mode = medianWords <= 12
    ? 'brief'
    : medianWords <= 35 ? 'balanced' : 'expanded';

  return { mode, instruction: GUIDANCE[mode], medianWords, sampleSize: counts.length };
}