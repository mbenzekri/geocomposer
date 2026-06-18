import { describe, expect, it } from 'vitest';
import { MarkupTemplate } from '../../src/core/template.js';
describe('MarkupTemplate', () => {
    it('renders plain text', () => {
        expect(MarkupTemplate.render('Hello world', {}))
            .toBe('Hello world');
    });
    it('renders escaped variables', () => {
        expect(MarkupTemplate.render('Hello {{name}}', {
            name: '<Bob>'
        })).toBe('Hello &lt;Bob&gt;');
    });
    it('renders unescaped variables with ampersand tag', () => {
        expect(MarkupTemplate.render('Hello {{& name}}', {
            name: '<Bob>'
        })).toBe('Hello <Bob>');
    });
    it('renders unescaped variables with triple braces', () => {
        expect(MarkupTemplate.render('Hello {{{name}}}', {
            name: '<Bob>'
        })).toBe('Hello <Bob>');
    });
    it('renders missing variables as empty strings', () => {
        expect(MarkupTemplate.render('Hello {{missing}}', {}))
            .toBe('Hello ');
    });
    it('renders nested properties', () => {
        expect(MarkupTemplate.render('{{user.name}}', {
            user: {
                name: 'Alice'
            }
        })).toBe('Alice');
    });
    it('renders null as empty string', () => {
        expect(MarkupTemplate.render('{{value}}', {
            value: null
        })).toBe('');
    });
    it('renders undefined as empty string', () => {
        expect(MarkupTemplate.render('{{value}}', {
            value: undefined
        })).toBe('');
    });
    it('renders zero as string', () => {
        expect(MarkupTemplate.render('{{value}}', {
            value: 0
        })).toBe('0');
    });
    it('renders false as string', () => {
        expect(MarkupTemplate.render('{{value}}', {
            value: false
        })).toBe('false');
    });
    it('renders comments as empty output', () => {
        expect(MarkupTemplate.render('A{{! ignored }}B', {}))
            .toBe('AB');
    });
    it('renders truthy sections', () => {
        expect(MarkupTemplate.render('{{#enabled}}yes{{/enabled}}', {
            enabled: true
        })).toBe('yes');
    });
    it('does not render falsy sections', () => {
        expect(MarkupTemplate.render('{{#enabled}}yes{{/enabled}}', {
            enabled: false
        })).toBe('');
    });
    it('renders sections with object context', () => {
        expect(MarkupTemplate.render('{{#user}}{{name}}{{/user}}', {
            user: {
                name: 'Alice'
            }
        })).toBe('Alice');
    });
    it('renders array sections', () => {
        expect(MarkupTemplate.render('{{#items}}{{name}};{{/items}}', {
            items: [
                { name: 'A' },
                { name: 'B' }
            ]
        })).toBe('A;B;');
    });
    it('renders current item with dot notation', () => {
        expect(MarkupTemplate.render('{{#items}}{{.}},{{/items}}', {
            items: ['A', 'B']
        })).toBe('A,B,');
    });
    it('renders current object with dot notation', () => {
        expect(MarkupTemplate.render('{{#items}}{{.}}{{/items}}', {
            items: ['A', 'B']
        })).toBe('AB');
    });
    it('falls back to parent context inside array sections', () => {
        expect(MarkupTemplate.render('{{#items}}{{prefix}}:{{name}};{{/items}}', {
            prefix: 'item',
            items: [
                { name: 'A' },
                { name: 'B' }
            ]
        })).toBe('item:A;item:B;');
    });
    it('renders nested sections with the same name', () => {
        expect(MarkupTemplate.render('{{#items}}[{{name}}{{#items}}:{{name}}{{/items}}]{{/items}}', {
            items: [
                {
                    name: 'A',
                    items: [
                        { name: 'A1' },
                        { name: 'A2' }
                    ]
                }
            ]
        })).toBe('[A:A1:A2]');
    });
    it('renders inverted section when value is an empty array', () => {
        expect(MarkupTemplate.render('{{^items}}empty{{/items}}', {
            items: []
        })).toBe('empty');
    });
    it('does not render inverted section when value is truthy', () => {
        expect(MarkupTemplate.render('{{^name}}missing{{/name}}', {
            name: 'Alice'
        })).toBe('');
    });
    it('renders section body using parent context for truthy primitive values', () => {
        expect(MarkupTemplate.render('{{#enabled}}{{name}}{{/enabled}}', {
            enabled: true,
            name: 'Alice'
        })).toBe('Alice');
    });
    it('renders empty string for property lookup on primitive items', () => {
        expect(MarkupTemplate.render('{{#items}}{{name}}{{/items}}', {
            items: ['A', 'B']
        })).toBe('');
    });
    it('throws on unclosed double brace tag', () => {
        expect(() => MarkupTemplate.render('Hello {{name', {
            name: 'Alice'
        })).toThrow('Unclosed template tag');
    });
    it('throws on unclosed triple brace tag', () => {
        expect(() => MarkupTemplate.render('Hello {{{name', {
            name: 'Alice'
        })).toThrow('Unclosed template tag');
    });
    it('throws on unexpected closing section', () => {
        expect(() => MarkupTemplate.render('{{/items}}', {})).toThrow('Unexpected closing template section: items');
    });
    it('throws on unclosed section', () => {
        expect(() => MarkupTemplate.render('{{#items}}item', {
            items: [1]
        })).toThrow('Unclosed template section: items');
    });
    it('throws on unclosed inverted section', () => {
        expect(() => MarkupTemplate.render('{{^items}}empty', {
            items: []
        })).toThrow('Unclosed template section: items');
    });
    it('throws on unclosed tag while searching for section end', () => {
        expect(() => MarkupTemplate.render('{{#items}}{{name{{/items}}', {
            items: [
                { name: 'A' }
            ]
        })).toThrow('Unclosed template tag');
    });
});
