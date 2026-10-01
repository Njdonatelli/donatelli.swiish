import React from 'react';
import { splitTerminalMark } from '../dot';

// Wraps only the terminal mark, so exactly one signal dot per heading (Decision 6).
export default function Heading({ level = 1, text, id, className }) {
  const Tag = level === 2 ? 'h2' : 'h1';
  const { head, mark, cls } = splitTerminalMark(text);
  return (
    <Tag id={id} className={className} tabIndex={level === 1 ? -1 : undefined}>
      {head}
      {mark ? <span className={cls}>{mark}</span> : null}
    </Tag>
  );
}
