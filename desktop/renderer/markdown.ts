import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

export function renderMarkdown(source: string) {
  const codes: string[] = [];
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });
  md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index].content);
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]; const language = token.info.trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9_+-]/g, '');
    const codeIndex = codes.push(token.content) - 1;
    const html = language && hljs.getLanguage(language) ? hljs.highlight(token.content, { language, ignoreIllegals: true }).value : md.utils.escapeHtml(token.content);
    return '<section class="code-block"><header><span>' + md.utils.escapeHtml(language || '代码') + '</span><button type="button" data-copy-code="' + codeIndex + '" aria-label="复制代码">复制代码</button></header><pre><code class="hljs">' + html + '</code></pre></section>';
  };
  return { html: md.render(source), codes };
}
