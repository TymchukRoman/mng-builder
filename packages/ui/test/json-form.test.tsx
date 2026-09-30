import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JsonForm, type JsonFormProps } from '../src/episode/JsonForm';

const noop = (): void => undefined;
const render = (value: unknown, readOnly = false): string => renderToStaticMarkup(<JsonForm value={value} onChange={noop} readOnly={readOnly} label="Outline" />);
/** The markup without the typed text and the size, i.e. the element structure React reconciles. */
const shape = (html: string): string => html.replace(/>[^<]*<\/textarea>/g, '></textarea>').replace(/ rows="\d+"/g, '');

/** The nested JsonForm elements a JsonForm renders (it has no hooks, so it can be called directly). */
function childForms(props: JsonFormProps): Array<ReactElement<JsonFormProps>> {
  const out: Array<ReactElement<JsonFormProps>> = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isValidElement(node)) return;
    if (node.type === JsonForm) { out.push(node as ReactElement<JsonFormProps>); return; }
    walk((node.props as { children?: ReactNode }).children);
  };
  walk(JsonForm(props));
  return out;
}

describe('JsonForm', () => {
  it('keeps the same element while a string grows past a line or gains a newline (review finding 1)', () => {
    const short = render({ title: 'Night market' });
    const long = render({ title: `Night market ${'x'.repeat(60)}` });
    const multi = render({ title: 'Night\nmarket' });
    expect(short).toContain('<textarea');
    expect(short).not.toContain('<input');
    // Same element type at the same position: React updates the node in place, so focus and the caret stay.
    expect(shape(long)).toBe(shape(short));
    expect(shape(multi)).toBe(shape(short));
    expect(long).toContain('rows="2"');
  });

  it('names nested fields by their path, and shows the path on the key (review finding 7)', () => {
    const html = render({ pages: [{ panels: [{ scene: 'rain', shot: 'wide' }] }] });
    expect(html).toContain('aria-label="pages[1].panels[1].scene"');
    expect(html).toContain('aria-label="pages[1].panels[1].shot"');
    expect(html).toContain('<span class="jf-key" data-tip="pages[1].panels[1].scene">scene</span>');
    expect(html).toContain('<span class="jf-key">pages</span>'); // a top-level key needs no tooltip
    expect(render('just text')).toContain('aria-label="Outline"');
  });

  it('numbers are plain text fields, so a minus sign or an empty field can be typed (review finding 2)', () => {
    const html = render({ pages: 2 });
    expect(html).toContain('inputMode="decimal"');
    expect(html).not.toContain('type="number"');
    expect(html).toContain('value="2"');
  });

  it('an edit deep in the tree replaces only that value (review finding 9)', () => {
    const value = { title: 'x', pages: [{ n: 1, panels: [{ scene: 'a' }, { scene: 'b' }] }, { n: 2, panels: [] }] };
    let out: unknown = null;
    const root: JsonFormProps = { value, onChange: (v) => { out = v; }, readOnly: false };
    const [, pages] = childForms(root);
    const [page1] = childForms(pages!.props);
    const [, panels] = childForms(page1!.props);
    const [, panel2] = childForms(panels!.props);
    const [scene] = childForms(panel2!.props);
    expect(scene!.props.path).toBe('pages[1].panels[2].scene');
    scene!.props.onChange('b, edited');
    expect(out).toEqual({ title: 'x', pages: [{ n: 1, panels: [{ scene: 'a' }, { scene: 'b, edited' }] }, { n: 2, panels: [] }] });
    const [n] = childForms(page1!.props);
    n!.props.onChange(-3);
    expect(out).toEqual({ ...value, pages: [{ ...value.pages[0], n: -3 }, value.pages[1]] });
  });

  it('read-only fields cannot be edited', () => {
    const html = render({ title: 'x', count: 1, ok: true }, true);
    expect(html.match(/readOnly=""/g)).toHaveLength(2);
    expect(html).toContain('disabled=""');
  });
});
