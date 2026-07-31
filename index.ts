/*!
 * I'm Queue Software Project
 * Copyright (C) 2025  imqueue.com <support@imqueue.com>
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
 * PostgreSQL-managed cache on Redis for `@imqueue` service methods: results are
 * memoised, and PostgreSQL itself says when to drop them.
 *
 * Decorate the service class with {@link PgCache}, then mark cached methods with
 * {@link cacheWith} or {@link cacheBy} to declare which tables they depend on.
 *
 * @remarks
 * The point is invalidation that is neither a guessed TTL nor a manual
 * `del()` call. {@link PgCache} installs a change-notify trigger on each declared
 * table and subscribes to one LISTEN/NOTIFY channel per table; when a row
 * changes, the entries tagged with that table are dropped. So an entry lives
 * exactly as long as the data behind it is unchanged.
 *
 * Two things to know. The triggers and the subscription are established in
 * `start()`, so a service that never starts is never cached. And a
 * {@link ChannelFilter} given as an array of {@link ChannelOperation} is an
 * EXCLUSION list — the operations named in it do not invalidate — which reads
 * the opposite way round from how it looks.
 *
 * @example
 * ```typescript
 * import { PgCache, cacheWith } from '@imqueue/pg-cache';
 *
 * @PgCache({
 *     postgres: process.env.DB_URL!,
 *     redis: { host: 'localhost', port: 6379 },
 * })
 * class UserService extends IMQService {
 *     @cacheWith({ channels: ['users'] })
 *     public async list(): Promise<User[]> {
 *         return this.db.query('SELECT * FROM users');
 *     }
 * }
 * ```
 *
 * @packageDocumentation
 */
export * from './src/index.js';
