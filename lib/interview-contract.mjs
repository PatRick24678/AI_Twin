// Coverage areas, NOT a bank of prewritten questions or a compulsory sequence.
export const INTERVIEW_TOPICS = Object.freeze({
  role: 'Role and responsibilities',
  tasks: 'Recurring tasks',
  workflow: 'A concrete workflow',
  tools: 'Tools and information',
  dependencies: 'People and handovers',
  friction: 'Difficulties and current workarounds',
  quality: 'What makes a good result',
  communication: 'Communication in context',
  decisions: 'Decisions and approvals',
  retain: 'What the person wants to keep doing',
  ai_experience: 'Experience and concerns about AI',
  desired_change: 'What a better workday would mean'
});

// The interviewer's own priority for opening new areas: the person first, process details later.
export const INTERVIEW_AGENDA = Object.freeze(['role', 'retain', 'friction', 'ai_experience', 'communication',
  'desired_change', 'workflow', 'tasks', 'quality', 'decisions', 'tools', 'dependencies']);

export const INTERVIEW_LIMITS = Object.freeze({
  turns: 10, // Hard cap; the signposted last question normally comes at 5–8.
  targetTurns: 6,
  latestLastQuestion: 8,
  questionsPerTopic: 3,
  unsuccessfulAnswersPerTopic: 2,
  answerCharacters: 3000
});

const ids = Object.keys(INTERVIEW_TOPICS);
const string = maxLength => ({ type: 'string', maxLength });
const choice = values => ({ type: 'string', enum: values });
const object = properties => ({
  type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties
});
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const evidence = {
  sourceMessageId: string(60),
  quote: string(INTERVIEW_LIMITS.answerCharacters)
};

// This schema stays identical across turns. IDs are data, not dynamic enums.
export const INTERVIEW_TURN_SCHEMA = object({
  acknowledgement: string(200),
  question: object({
    topic: choice([...ids, 'none']),
    text: string(350),
    gap: string(200),
    move: choice(['follow_up', 'new_area']),
    last: { type: 'boolean' }
  }),
  observations: array(object({
    topic: choice(ids),
    statement: string(240),
    ...evidence,
    replacesId: string(60)
  }), 6),
  boundaries: array(object({
    topic: choice(ids),
    reason: choice(['declined', 'not_applicable']),
    ...evidence
  }), 12),
  retractions: array(object({
    observationId: string(60),
    ...evidence
  }), 6),
  stopQuote: string(INTERVIEW_LIMITS.answerCharacters)
});

export class InterviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InterviewError';
  }
}

export function assertInterview(condition, message) {
  if (!condition) throw new InterviewError(message);
}

// Validates only the schema features used above, not arbitrary JSON Schema.
// Run locally even when a provider claims schema-constrained output.
export function validateInterviewTurn(value) {
  function visit(item, schema, path) {
    if (schema.type === 'object') {
      assertInterview(
        item !== null && typeof item === 'object' && !Array.isArray(item),
        `${path} must be an object.`
      );
      const keys = Object.keys(schema.properties);
      assertInterview(
        Object.keys(item).length === keys.length &&
        keys.every(key => Object.hasOwn(item, key)),
        `${path} has missing or unexpected fields.`
      );
      for (const key of keys) visit(item[key], schema.properties[key], `${path}.${key}`);
    } else if (schema.type === 'array') {
      assertInterview(
        Array.isArray(item) && item.length <= schema.maxItems,
        `${path} has an invalid number of items.`
      );
      item.forEach((child, index) => visit(child, schema.items, `${path}[${index}]`));
    } else if (schema.type === 'boolean') {
      assertInterview(typeof item === 'boolean', `${path} must be true or false.`);
    } else {
      assertInterview(typeof item === 'string', `${path} must be text.`);
      assertInterview(
        schema.maxLength === undefined || item.length <= schema.maxLength,
        `${path} is too long.`
      );
      assertInterview(!schema.enum || schema.enum.includes(item), `${path} has an invalid value.`);
    }
  }
  visit(value, INTERVIEW_TURN_SCHEMA, 'turn');
  return value;
}