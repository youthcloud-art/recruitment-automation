import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseOutlined } from '@ant-design/icons';
import { apiGet } from '../utils/apiClient';
import './ResumeDetailModal.css';

export default function ResumeDetailModal({ visible, onClose, resume }) {
  const [presentation, setPresentation] = useState(null);
  const [error, setError] = useState('');
  const [position, setPosition] = useState(null);
  const [loading, setLoading] = useState(false);
  const windowRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    if (!visible || !resume?.id) return undefined;
    let active = true;
    setPosition(null);
    setPresentation(null);
    setError('');
    setLoading(true);
    apiGet(`/resume/${encodeURIComponent(resume.id)}/presentation`)
      .then(result => { if (active) setPresentation(result.data); })
      .catch(reason => { if (active) setError(reason.message || '简历详情读取失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible, resume?.id]);

  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, onClose]);

  if (!visible || !resume) return null;

  const startDrag = event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const bounds = windowRef.current.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
    setPosition({ left: bounds.left, top: bounds.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = event => {
    if (!dragRef.current || event.pointerId !== dragRef.current.pointerId) return;
    const { offsetX, offsetY } = dragRef.current;
    const bounds = windowRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(0, Math.min(window.innerWidth - bounds.width, event.clientX - offsetX)),
      top: Math.max(0, Math.min(window.innerHeight - 48, event.clientY - offsetY))
    });
  };
  const stopDrag = event => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  return createPortal(<div className="resume-window-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <article ref={windowRef} className="resume-window" role="dialog" aria-modal="true"
      aria-label="简历详情" style={position ? { ...position, transform: 'none' } : undefined}>
      <div className="resume-window-handle" onPointerDown={startDrag}
        onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
        <span>简历详情 <small>拖动标题栏移动 · 拖动右下角调整大小</small></span>
        <button type="button" aria-label="关闭简历详情" onClick={onClose}><CloseOutlined /></button>
      </div>
      {loading ? <div className="resume-window-state">正在整理简历…</div> : error
        ? <div className="resume-window-state" role="alert">{error}</div> : presentation &&
        <div className="resume-window-scroll">
          <div className="resume-paper">
            <header className="resume-paper-header">
              <div className="resume-paper-kicker">候选人简历 · {presentation.source}</div>
              <h1>{presentation.name}</h1>
              <div className="resume-paper-facts">{presentation.metadata.map(([label, value]) =>
                <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
            </header>
            <div className="resume-paper-content">
              {presentation.sections.length ? presentation.sections.map((section, index) =>
                <section key={`${section.title}-${index}`}>
                  <h2>{section.title}</h2>
                  {section.paragraphs.map((paragraph, line) => <p key={line}>{paragraph}</p>)}
                </section>) : <p>暂无可展示的简历正文，请核对原始采集记录。</p>}
              <p className="resume-paper-note">{presentation.note}</p>
            </div>
          </div>
        </div>}
    </article>
  </div>, document.body);
}
