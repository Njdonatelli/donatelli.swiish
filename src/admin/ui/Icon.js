import React from 'react';
import { createLucideIcon } from 'lucide-react';

export {
  AlertTriangle, ArrowLeft, Check, Download, ExternalLink, Eye, EyeOff, Globe, History, LayoutDashboard,
  LogOut, Mail, RefreshCw, RotateCcw, Trash2, User, UserPlus, Users, X, Calendar, Copy, Share2, ChevronDown, Plus,
} from 'lucide-react';

// lucide-react 0.263.1 predates the IdCard glyph the spec names for the Card tab. This is Lucide's own
// id-card geometry (lucide-static 0.460.0), built with the library's factory so it renders like every
// other icon.
export const IdCard = createLucideIcon('IdCard', [
  ['path', { d: 'M16 10h2', key: 'idc1' }],
  ['path', { d: 'M16 14h2', key: 'idc2' }],
  ['path', { d: 'M6.17 15a3 3 0 0 1 5.66 0', key: 'idc3' }],
  ['circle', { cx: '9', cy: '11', r: '2', key: 'idc4' }],
  ['rect', { x: '2', y: '5', width: '20', height: '14', rx: '2', key: 'idc5' }],
]);

// Every icon goes through here so the stroke is always the system's 1.5. An icon is decorative unless it
// carries its own label; a button or link around it supplies the text otherwise.
export default function Icon({ as: Glyph, size = 20, label, className }) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true', focusable: 'false' };
  return <Glyph size={size} strokeWidth={1.5} className={className} {...a11y} />;
}
