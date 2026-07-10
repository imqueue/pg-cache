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
/**
 * The decorators are dual-mode. This file exercises both calling
 * conventions against the same behaviour:
 *  - standard (TC39): the classes below are compiled with the package
 *    tsconfig (no experimentalDecorators), so `@cacheWith`/`@cacheBy`/
 *    `@PgCache` here are emitted as standard decorators;
 *  - legacy: the decorator functions are invoked manually with the
 *    (prototype, methodName, descriptor) signature a legacy compiler emits.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cacheWith } from '../src/cacheWith.js';
import { cacheBy } from '../src/cacheBy.js';
import { PgCache } from '../src/PgCache.js';

// minimal in-memory stand-in for @imqueue/tag-cache
class FakeCache {
    public store = new Map<string, any>();

    public async get(key: string): Promise<any> {
        return this.store.has(key) ? this.store.get(key) : null;
    }

    public async set(key: string, value: any): Promise<boolean> {
        this.store.set(key, value);

        return true;
    }
}

// minimal sequelize model stand-in for cacheBy(model)
const FakeModel: any = { associations: {}, tableName: 'fakes' };

function channelsOfProto(proto: any): Record<string, unknown[]> {
    return proto.pgCacheChannels || {};
}

describe('decorators (dual-mode)', () => {
    describe('@cacheWith', () => {
        it('should cache and register channels as a standard decorator', async () => {
            class StdService {
                public runs = 0;
                public taggedCache = new FakeCache();

                @cacheWith({ channels: ['users'] })
                public async getData(id: number): Promise<any> {
                    this.runs++;

                    return { id, at: this.runs };
                }
            }

            const service = new StdService();
            const first = await service.getData(1);
            const second = await service.getData(1);

            assert.equal(service.runs, 1, 'original must run only once');
            assert.deepEqual(second, first, 'second call must be cached');

            const channels = channelsOfProto(Object.getPrototypeOf(service));

            assert.ok(channels.users, 'channel must be registered');
        });

        it('should cache and register channels as a legacy decorator', async () => {
            class LegacyService {
                public runs = 0;
                public taggedCache = new FakeCache();

                public async getData(id: number): Promise<any> {
                    this.runs++;

                    return { id, at: this.runs };
                }
            }

            const proto = LegacyService.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(
                proto,
                'getData',
            )!;

            // legacy invocation: (target, propertyKey, descriptor)
            const patched: any = cacheWith({ channels: ['users'] })(
                proto,
                'getData',
                descriptor,
            );

            Object.defineProperty(proto, 'getData', patched);

            // channels are registered at decoration time in legacy mode
            assert.ok(channelsOfProto(proto).users);

            const service = new LegacyService();
            const first = await service.getData(1);
            const second = await service.getData(1);

            assert.equal(service.runs, 1);
            assert.deepEqual(second, first);
        });

        it('should not run the original again for identical arguments only', async () => {
            class Svc {
                public runs = 0;
                public taggedCache = new FakeCache();

                @cacheWith({ channels: ['t'] })
                public async fn(a: number): Promise<number> {
                    this.runs++;

                    return a * 2;
                }
            }

            const svc = new Svc();

            assert.equal(await svc.fn(2), 4);
            assert.equal(await svc.fn(2), 4);
            assert.equal(await svc.fn(3), 6);
            assert.equal(svc.runs, 2, 'distinct args must miss the cache');
        });

        it('should bypass caching when no taggedCache is present', async () => {
            class NoCache {
                public runs = 0;

                @cacheWith({ channels: ['t'] })
                public async fn(): Promise<string> {
                    this.runs++;

                    return 'ok';
                }
            }

            const svc = new NoCache();

            assert.equal(await svc.fn(), 'ok');
            assert.equal(await svc.fn(), 'ok');
            assert.equal(svc.runs, 2, 'no cache => original runs each time');
        });
    });

    describe('@cacheBy', () => {
        it('should cache and register model channels as a standard decorator', async () => {
            class StdService {
                public runs = 0;
                public taggedCache = new FakeCache();

                @cacheBy(FakeModel)
                public async list(): Promise<any[]> {
                    this.runs++;

                    return [this.runs];
                }
            }

            const service = new StdService();
            const first = await service.list();
            const second = await service.list();

            assert.equal(service.runs, 1);
            assert.deepEqual(second, first);
            assert.ok(
                channelsOfProto(Object.getPrototypeOf(service)).fakes,
                'model table channel must be registered',
            );
        });

        it('should cache and register model channels as a legacy decorator', async () => {
            class LegacyService {
                public runs = 0;
                public taggedCache = new FakeCache();

                public async list(): Promise<any[]> {
                    this.runs++;

                    return [this.runs];
                }
            }

            const proto = LegacyService.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'list')!;
            const patched: any = cacheBy(FakeModel)(proto, 'list', descriptor);

            Object.defineProperty(proto, 'list', patched);

            assert.ok(channelsOfProto(proto).fakes);

            const service = new LegacyService();

            await service.list();
            await service.list();

            assert.equal(service.runs, 1);
        });
    });

    describe('@PgCache', () => {
        it(
            'should augment a class with a start method as a standard ' +
                'decorator',
            () => {
                @PgCache({ postgres: 'postgres://localhost/db' } as any)
                class StdService {
                    public async start(): Promise<void> {
                        /* original start */
                    }
                }

                assert.equal(
                    typeof (StdService.prototype as any).start,
                    'function',
                );
            },
        );

        it('should augment a class as a legacy decorator', () => {
            class LegacyService {
                public async start(): Promise<void> {
                    /* original start */
                }
            }

            // legacy invocation: (constructor)
            const decorated: any = PgCache({
                postgres: 'postgres://localhost/db',
            } as any)(LegacyService as any);

            assert.equal(typeof decorated, 'function');
            assert.equal(typeof decorated.prototype.start, 'function');
        });
    });
});
