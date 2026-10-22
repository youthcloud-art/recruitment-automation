import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import KnowledgeSearchResult from './KnowledgeSearchResult';

test('renders untrusted document content as text and handles regex characters in query', () => {
  const content = '<img src=x onerror=alert(1)> 报销(高铁)';
  const markup = renderToStaticMarkup(
    <KnowledgeSearchResult
      query="报销("
      results={[{
        id: 1,
        content,
        similarity: 0.9,
        metadata: { document_id: 1, document_title: '差旅制度', chunk_index: 0 }
      }]}
    />
  );
  const container = document.createElement('div');
  container.innerHTML = markup;
  expect(container.textContent).toContain(content);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('mark').textContent).toBe('报销(');
});
