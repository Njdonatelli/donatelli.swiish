import React from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';

function classes(variant, danger, block, className) {
  return ['btn', 'btn-' + (variant || 'secondary'), danger && 'btn-danger', block && 'btn-block', className]
    .filter(Boolean)
    .join(' ');
}

function Content({ icon, iconSize, children }) {
  return (
    <>
      {icon ? <Icon as={icon} size={iconSize || 16} /> : null}
      {children}
    </>
  );
}

export default function Button({ variant, danger, block, icon, iconSize, className, type = 'button', busy, disabled, children, ...rest }) {
  return (
    <button
      type={type}
      className={classes(variant, danger, block, className)}
      disabled={disabled || busy}
      aria-busy={busy ? 'true' : undefined}
      {...rest}
    >
      <Content icon={icon} iconSize={iconSize}>{children}</Content>
    </button>
  );
}

export function ButtonLink({ variant, danger, block, icon, iconSize, className, to, children, ...rest }) {
  return (
    <Link to={to} className={classes(variant, danger, block, className)} {...rest}>
      <Content icon={icon} iconSize={iconSize}>{children}</Content>
    </Link>
  );
}

// donatelli.tech forbids framing (frame-ancestors), so every site link opens a new tab.
export function ExternalLink({ variant, danger, block, icon, iconSize, className, href, children, ...rest }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={classes(variant, danger, block, className)} {...rest}>
      <Content icon={icon} iconSize={iconSize}>{children}</Content>
    </a>
  );
}
