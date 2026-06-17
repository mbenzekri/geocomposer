import { describe, expect, it } from 'vitest';
import { DefsSolver } from '../../src/config/defs-solver.js';
describe('DefsSolver - depth and edge cases', () => {
    it('resolves deeply nested references', () => {
        const document = {
            $defs: {
                level1: { $ref: '#/$defs/level2' },
                level2: { $ref: '#/$defs/level3' },
                level3: {
                    value: 'resolved'
                }
            },
            config: {
                $ref: '#/$defs/level1'
            }
        };
        const result = new DefsSolver().solve(document);
        expect(result).toEqual({
            config: {
                value: 'resolved'
            }
        });
    });
    it('resolves references nested inside arrays and objects', () => {
        const document = {
            $defs: {
                item: {
                    label: 'A',
                    nested: {
                        enabled: true
                    }
                }
            },
            config: {
                sections: [
                    {
                        fields: [
                            {
                                $ref: '#/$defs/item'
                            }
                        ]
                    }
                ]
            }
        };
        const result = new DefsSolver().solve(document);
        expect(result).toEqual({
            config: {
                sections: [
                    {
                        fields: [
                            {
                                label: 'A',
                                nested: {
                                    enabled: true
                                }
                            }
                        ]
                    }
                ]
            }
        });
    });
    it('detects circular references across multiple levels', () => {
        const document = {
            $defs: {
                a: { $ref: '#/$defs/b' },
                b: { $ref: '#/$defs/c' },
                c: { $ref: '#/$defs/a' }
            },
            config: {
                $ref: '#/$defs/a'
            }
        };
        expect(() => new DefsSolver().solve(document)).toThrow('Circular config definition reference');
    });
    it('throws when a deep reference points to an unknown definition', () => {
        const document = {
            $defs: {
                a: {
                    child: {
                        $ref: '#/$defs/missing'
                    }
                }
            },
            config: {
                $ref: '#/$defs/a'
            }
        };
        expect(() => new DefsSolver().solve(document)).toThrow('Unknown config definition pointer "#/$defs/missing"');
    });
    it('handles very deep reference chains', () => {
        const document = {
            $defs: {
                d1: { $ref: '#/$defs/d2' },
                d2: { $ref: '#/$defs/d3' },
                d3: { $ref: '#/$defs/d4' },
                d4: { $ref: '#/$defs/d5' },
                d5: { value: 'final' }
            },
            config: {
                $ref: '#/$defs/d1'
            }
        };
        const result = new DefsSolver().solve(document);
        expect(result).toEqual({
            config: {
                value: 'final'
            }
        });
    });
    it('throws when $defs is not an object', () => {
        const document = {
            $defs: 'invalid',
            config: {}
        };
        expect(() => new DefsSolver().solve(document)).toThrow('Invalid config definitions at /$defs in configuration: expected an object');
    });
    it('throws when $ref is not a string', () => {
        const document = {
            config: {
                $ref: 123
            }
        };
        expect(() => new DefsSolver().solve(document)).toThrow('Invalid config reference at /config in configuration: "$ref" must be a string');
    });
    it('throws when a local override is provided on a non-object reference', () => {
        const document = {
            $defs: {
                port: 8080
            },
            config: {
                $ref: '#/$defs/port',
                description: 'database port'
            }
        };
        expect(() => new DefsSolver().solve(document)).toThrow('Invalid config reference at /config in configuration: "#/$defs/port" must resolve to an object when local overrides are provided');
    });
    it('throws when a definition pointer has no definition name', () => {
        const document = {
            $defs: {
                value: 'x'
            },
            config: '#/$defs'
        };
        expect(() => new DefsSolver().solve(document)).toThrow('Invalid config definition pointer "#/$defs" at /config in configuration: expected a definition name');
    });
    it('throws when a JSON pointer escape is invalid', () => {
        const document = {
            $defs: {
                value: 'x'
            },
            config: '#/$defs/a~2b'
        };
        expect(() => new DefsSolver().solve(document)).toThrow('Invalid JSON pointer escape in "#/$defs/a~2b" at /config in configuration');
    });
    it('throws when a nested pointer segment is unknown', () => {
        const document = {
            $defs: {
                item: {
                    name: 'value'
                }
            },
            config: '#/$defs/item/missing'
        };
        expect(() => new DefsSolver().solve(document)).toThrow('Unknown config definition pointer "#/$defs/item/missing" at /config in configuration');
    });
});
