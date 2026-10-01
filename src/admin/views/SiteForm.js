import React from 'react';
import Heading from '../ui/Heading';
import Button from '../ui/Button';
import Icon, { Plus, X } from '../ui/Icon';
import { ReadOnlyField, SwitchField, TextAreaField, TextField } from '../ui/Field';
import { withTerminalMark } from '../dot';
import { getPath, schemaAt, typesOf } from '../config-path';

// Card tab order from the spec (§5.7), then the Website tab's groups; a group the schema adds later lands last.
const GROUP_ORDER = ['Person', 'Contact', 'Profiles', 'Card', 'Send me your details', 'Brand', 'Location', 'Business profiles', 'Footer'];

// The same walk as the server's listFields(schema), for when the response carries only the schema.
function deriveFields(node, prefix = '', out = []) {
  const props = (node && node.properties) || {};
  Object.keys(props).forEach((key) => {
    const child = props[key];
    const path = prefix ? prefix + '.' + key : key;
    if (child['x-tab']) {
      out.push({
        path,
        title: child.title,
        description: child.description,
        tab: child['x-tab'],
        group: child['x-group'],
        readOnly: !!child['x-readOnly'],
      });
    } else if (child.properties) {
      deriveFields(child, path, out);
    }
  });
  return out;
}

export function allFields(schema, fields) {
  return Array.isArray(fields) && fields.length && fields[0].path ? fields : deriveFields(schema);
}

export function fieldsForTab(schema, fields, tab) {
  return allFields(schema, fields).filter((f) => f.tab === tab);
}

function groupsOf(list) {
  const map = new Map();
  list.forEach((f) => {
    const g = f.group || 'Other';
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(f);
  });
  const rank = (g) => (GROUP_ORDER.indexOf(g) === -1 ? GROUP_ORDER.length : GROUP_ORDER.indexOf(g));
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

// "Extra links" → "link": items are named by the last word of the list's title.
function nounOf(title) {
  const last = String(title || 'item').trim().split(/\s+/).pop().toLowerCase();
  return last.replace(/s$/, '');
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const idFor = (path) => 'f-' + String(path).replace(/[^A-Za-z0-9]+/g, '-');

function errorAt(errors, path) {
  const hit = (errors || []).find((e) => e.path === path);
  return hit ? hit.message : null;
}

function display(value) {
  if (value == null || value === '') return 'Empty';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Empty';
  return String(value);
}

// Input for one string or integer value. Nullable fields store null when cleared, so the site leaves the block
// out instead of rendering an empty string.
function ScalarInput({ path, node, meta, value, error, onChange, label }) {
  const types = typesOf(node);
  const nullable = types.includes('null');
  const isInt = types.includes('integer');
  const pattern = node.pattern || '';
  const common = {
    id: idFor(path),
    label: label || meta.title || path,
    hint: meta.description || node.description,
    error,
    value: value == null ? '' : String(value),
  };
  if (isInt) {
    return (
      <TextField
        {...common}
        type="number"
        inputMode="numeric"
        min={node.minimum}
        max={node.maximum}
        step="1"
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') onChange(nullable ? null : raw);
          else onChange(/^-?\d+$/.test(raw) ? Number(raw) : raw);
        }}
      />
    );
  }
  const toValue = (raw) => (raw === '' && nullable ? null : raw);
  if (node['x-widget'] === 'textarea') {
    return <TextAreaField {...common} rows={4} maxLength={node.maxLength} onChange={(e) => onChange(toValue(e.target.value))} />;
  }
  const kind = pattern.indexOf('^https://') === 0 ? 'url' : pattern.indexOf('@') !== -1 ? 'email' : 'text';
  return (
    <TextField
      {...common}
      type={kind}
      inputMode={kind === 'text' ? undefined : kind}
      autoCapitalize={kind === 'text' ? undefined : 'none'}
      spellCheck={kind === 'text' ? undefined : 'false'}
      maxLength={node.maxLength}
      onChange={(e) => onChange(toValue(e.target.value))}
    />
  );
}

function StringList({ path, node, meta, value, errors, onChange }) {
  const items = Array.isArray(value) ? value : [];
  const itemNode = node.items || { type: 'string' };
  const noun = nounOf(meta.title);
  const max = node.maxItems || Infinity;
  return (
    <fieldset className="repeat">
      <legend>{meta.title || path}</legend>
      {meta.description ? <p className="field-hint">{meta.description}</p> : null}
      {items.length === 0 ? <p className="field-hint">None yet.</p> : null}
      {items.map((item, i) => (
        <div className="list-item" key={i}>
          <ScalarInput
            path={path + '.' + i}
            node={itemNode}
            meta={{}}
            label={cap(noun) + ' ' + (i + 1)}
            value={item}
            error={errorAt(errors, path + '.' + i)}
            onChange={(v) => onChange(path, items.map((x, j) => (j === i ? (v == null ? '' : v) : x)))}
          />
          <Button variant="quiet" className="btn-icon" aria-label={'Remove ' + noun + ' ' + (i + 1)} onClick={() => onChange(path, items.filter((_, j) => j !== i))}>
            <Icon as={X} size={20} />
          </Button>
        </div>
      ))}
      {errorAt(errors, path) ? <p className="field-error">{errorAt(errors, path)}</p> : null}
      <div>
        <Button variant="secondary" icon={Plus} disabled={items.length >= max} onClick={() => onChange(path, [...items, ''])}>
          Add {noun}
        </Button>
      </div>
    </fieldset>
  );
}

function ObjectList({ path, node, meta, value, errors, onChange }) {
  const items = Array.isArray(value) ? value : [];
  const props = (node.items && node.items.properties) || {};
  const keys = Object.keys(props);
  const max = node.maxItems || Infinity;
  const blank = keys.reduce((o, k) => ({ ...o, [k]: '' }), {});
  const noun = nounOf(meta.title);
  return (
    <fieldset className="repeat">
      <legend>{meta.title || path}</legend>
      {meta.description ? <p className="field-hint">{meta.description}</p> : null}
      {items.length === 0 ? <p className="field-hint">None yet.</p> : null}
      {items.map((item, i) => {
        const itemName = cap(noun) + ' ' + (i + 1);
        const nameId = idFor(path + '.' + i) + '-name';
        // Every item has the same property titles ("Label", "Link"), so each input's name carries the item
        // number too, for a screen reader's form list and for the error announced on the field.
        return (
          <div className="stack-sm" key={i} role="group" aria-labelledby={nameId}>
            <div className="split">
              <span className="eyebrow" id={nameId}>{itemName}</span>
              <Button variant="quiet" icon={X} onClick={() => onChange(path, items.filter((_, j) => j !== i))}>
                Remove {noun} {i + 1}
              </Button>
            </div>
            {keys.map((k) => (
              <ScalarInput
                key={k}
                path={path + '.' + i + '.' + k}
                node={props[k]}
                meta={{ title: props[k].title || k }}
                label={<><span className="sr-only">{itemName}, </span>{props[k].title || k}</>}
                value={item ? item[k] : ''}
                error={errorAt(errors, path + '.' + i + '.' + k) || errorAt(errors, path + '.' + i)}
                onChange={(v) => onChange(path, items.map((x, j) => (j === i ? { ...x, [k]: v == null ? '' : v } : x)))}
              />
            ))}
          </div>
        );
      })}
      {errorAt(errors, path) ? <p className="field-error">{errorAt(errors, path)}</p> : null}
      <div>
        <Button variant="secondary" icon={Plus} disabled={items.length >= max} onClick={() => onChange(path, [...items, blank])}>
          Add {noun}
        </Button>
      </div>
    </fieldset>
  );
}

function FieldFor({ schema, meta, config, errors, onChange }) {
  const node = schemaAt(schema, meta.path) || {};
  const value = getPath(config, meta.path);
  const types = typesOf(node);
  const error = errorAt(errors, meta.path);

  if (meta.path === 'owner.name') {
    return (
      <ReadOnlyField
        label={meta.title || 'Full name'}
        value={display(value)}
        hint="Given name, a space, then family name. It follows the two fields below."
      />
    );
  }
  if (meta.readOnly) {
    const mono = typeof value === 'string' && value.charAt(0) === '/';
    return <ReadOnlyField label={meta.title || meta.path} value={display(value)} mono={mono} />;
  }
  if (types.includes('boolean')) {
    return <SwitchField id={idFor(meta.path)} label={meta.title} hint={meta.description} error={error} checked={value} onChange={(v) => onChange(meta.path, v)} />;
  }
  if (types.includes('array')) {
    const itemTypes = typesOf(node.items);
    const List = itemTypes.includes('object') ? ObjectList : StringList;
    return <List path={meta.path} node={node} meta={meta} value={value} errors={errors} onChange={onChange} />;
  }
  return <ScalarInput path={meta.path} node={node} meta={meta} value={value} error={error} onChange={(v) => onChange(meta.path, v)} />;
}

// The schema drives the form: x-tab picks the tab, x-group the section, title and description the labels.
// groupAs="h2" gives each group a heading (Card tab); "eyebrow" keeps them as labels under a parent h2.
export default function SiteForm({ schema, fields, tab, config, errors, onChange, groupAs = 'h2', groupNotes = {} }) {
  if (!schema || !config) return null;
  const groups = groupsOf(fieldsForTab(schema, fields, tab));
  return (
    <div>
      {groups.map(([group, list]) => (
        <section className="form-group" key={group} aria-label={groupAs === 'h2' ? undefined : group}>
          {groupAs === 'h2' ? <Heading level={2} text={withTerminalMark(group)} /> : <p className="eyebrow">{group}</p>}
          {groupNotes[group] || null}
          {list.map((meta) => (
            <FieldFor key={meta.path} schema={schema} meta={meta} config={config} errors={errors} onChange={onChange} />
          ))}
        </section>
      ))}
    </div>
  );
}
