/*!
 * I'm Queue Software Project
 * Copyright (C) 2026  imqueue.com <support@imqueue.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * If you want to use this code in a closed source (commercial) project, you can
 * purchase a proprietary commercial license. Please contact us at
 * <support@imqueue.com> to get commercial licensing options.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signature } from '../src/signature.js';

describe('signature()', () => {
    it('should return a 16-char hex string', () => {
        assert.match(signature('Klass', 'method', []), /^[0-9a-f]{16}$/);
    });

    it('should be deterministic for identical input', () => {
        assert.equal(
            signature('Klass', 'method', [1, 'a', { x: 1 }]),
            signature('Klass', 'method', [1, 'a', { x: 1 }]),
        );
    });

    it('should not depend on object key insertion order', () => {
        assert.equal(
            signature('Klass', 'method', [{ a: 1, b: 2 }]),
            signature('Klass', 'method', [{ b: 2, a: 1 }]),
        );
    });

    it('should differ for different class, method or args', () => {
        const base = signature('Klass', 'method', [1]);

        assert.notEqual(signature('Other', 'method', [1]), base);
        assert.notEqual(signature('Klass', 'other', [1]), base);
        assert.notEqual(signature('Klass', 'method', [2]), base);
    });

    it('should not throw on circular arguments', () => {
        const arg: any = { a: 1 };
        arg.self = arg;

        assert.doesNotThrow(() => signature('Klass', 'method', [arg]));
        assert.equal(
            signature('Klass', 'method', [arg]),
            signature('Klass', 'method', [arg]),
        );
    });

    it('should honor toJSON on argument objects', () => {
        const withToJson = { toJSON: () => ({ x: 1 }) };

        assert.equal(
            signature('Klass', 'method', [withToJson]),
            signature('Klass', 'method', [{ x: 1 }]),
        );
    });

    it('should serialize bigint arguments without throwing', () => {
        assert.doesNotThrow(() => signature('Klass', 'method', [10n ** 20n]));
    });
});
