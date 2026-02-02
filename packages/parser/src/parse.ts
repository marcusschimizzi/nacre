import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Root, Heading, Text, InlineCode } from 'mdast';

export interface Section {
  heading: string;
  headingPath: string;
  content: string;
  startLine: number;
  endLine: number;
}

export function parseMarkdown(content: string): Root {
  return unified().use(remarkParse).parse(content);
}

function extractTextFromNode(node: { type: string; children?: unknown[]; value?: string }): string {
  if (node.type === 'text') return (node as Text).value;
  if (node.type === 'inlineCode') return `\`${(node as InlineCode).value}\``;
  if (Array.isArray(node.children)) {
    return node.children.map((child) => extractTextFromNode(child as typeof node)).join('');
  }
  return '';
}

export function extractSections(tree: Root, _filePath: string): Section[] {
  const sections: Section[] = [];
  let currentHeading = 'intro';
  let currentHeadingPath = '(intro)';
  let currentContent: string[] = [];
  let currentStartLine = 1;

  for (const child of tree.children) {
    if (child.type === 'heading' && (child as Heading).depth === 2) {
      if (currentContent.length > 0 || sections.length === 0) {
        const endLine = child.position?.start?.line
          ? child.position.start.line - 1
          : currentStartLine;
        if (currentContent.join('\n').trim()) {
          sections.push({
            heading: currentHeading,
            headingPath: currentHeadingPath,
            content: currentContent.join('\n'),
            startLine: currentStartLine,
            endLine: Math.max(endLine, currentStartLine),
          });
        }
      }

      const heading = child as Heading;
      currentHeading = extractTextFromNode(heading);
      currentHeadingPath = `## ${currentHeading}`;
      currentContent = [];
      currentStartLine = heading.position?.start?.line ?? currentStartLine;
    } else {
      const text = extractTextFromNode(child as Parameters<typeof extractTextFromNode>[0]);
      if (text.trim()) {
        currentContent.push(text);
      }
    }
  }

  if (currentContent.join('\n').trim()) {
    const lastChild = tree.children[tree.children.length - 1];
    const endLine = lastChild?.position?.end?.line ?? currentStartLine;
    sections.push({
      heading: currentHeading,
      headingPath: currentHeadingPath,
      content: currentContent.join('\n'),
      startLine: currentStartLine,
      endLine,
    });
  }

  if (sections.length === 0) {
    let allText = '';
    visit(tree, 'text', (node: Text) => {
      allText += node.value + '\n';
    });
    sections.push({
      heading: 'intro',
      headingPath: '(intro)',
      content: allText.trim(),
      startLine: 1,
      endLine: tree.position?.end?.line ?? 1,
    });
  }

  return sections;
}
