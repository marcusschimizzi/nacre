export type { ConsolidateOptions } from './pipeline.js';
export { consolidate } from './pipeline.js';

export { hashFile, scanDirectories, detectChanges } from './discover.js';
export { parseMarkdown, extractSections } from './parse.js';
export type { Section } from './parse.js';
export { extractStructural } from './extract/structural.js';
export { extractNLP } from './extract/nlp.js';
export { extractCustom } from './extract/custom.js';
export {
  processFileExtractions,
  deduplicateRawEntities,
} from './merge.js';
