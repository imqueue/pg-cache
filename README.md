# @imqueue/pg-cache

V3 uses sequelize v6.x

Links `@imqueue/pg-pubsub` with `@imqueue/tag-cache` and provides generic
way to implement intellectual cache management based on database changes
notifications for @imqueue-based service methods.

## Usage

~~~typescript
import { IMQService, expose } from '@imqueue/rpc';
import { PgCache, cacheWith } from '@imqueue/pg-cache';
import { MyDbEntity } from './orm/models';

@PgCache({
    postgres: 'postgres://localhost:5432/db-name',
    redis: { host: 'localhost', port: 6379 },
    prefix: 'my-cool-service', // optional, if not passed will use class name as prefix
})
class MyCoolService extends IMQService {
    @expose()
    @cacheWith({ channels: [MyDbEnity.tableName] })
    public async listEntities(): Promise<MyDbEntity> {
        return await MyDbEntity.findAll();
    }
}
~~~

With the setup, described above first call to `MyCoolService.listEntities()`
will save method return value to cache and each next call will return cached
value, stored in redis instead of making database query.
Each function call is signed by a call signature, so if your method accepts 
arguments which influence database query execution caching is made for each
unique method call. Cached result will be automatically invalidated each time
each table described in channels will trigger `INSERT`, `UPDATE` or `DELETE`. Or
when TTL on a cache entity expires. By default TTL is 24 hours. If you want
different TTL to be used, do it as:

~~~typescript
@cacheWith({ channels: [MyDbEnity.tableName], ttl: 5 * 60 * 1000 })
~~~

In this example TTL is set to 5 minutes. TTL should be provided in milliseconds.

### Using @cacheBy

Since v2.0.0 @cacheBy decorator introduced and helps simplify caching 
invalidation definition for those service methods which rely on a root sequelize
model output. In combination of passing the fields map to such service methods
it will also provide more efficient caching for the method calls.

Take a look at such example: 

~~~typescript
import { IMQService, expose } from '@imqueue/rpc';
import { PgCache, cacheBy } from '@imqueue/pg-cache';
import {
    FieldsInput,
    FindOptions,
    OrderByInput,
    PaginationInput,
    query,
} from '@imqueue/sequelize';
import { cacheConfig } from '../config';
import { MyDbEntity } from './orm/models';
import { MyDbEntityFilter } from './types';
import withRangeFilters = query.withRangeFilters;
import autoCountQuery = query.autoCountQuery;
import autoQuery = query.autoQuery;
import toWhereOptions = query.toWhereOptions;
import toLimitOptions = query.toLimitOptions;
import toOrderOptions = query.toOrderOptions;

@PgCache(cacheConfig)
class MyCoolService extends IMQService {
    @expose()
    @cacheBy(MyDbEntity, { fieldsArg: 1 })
    public async listEntities(
        filter?: MyDbEntityFilter,
        fields?: FieldsInput,
        pageOptions?: PaginationInput,
        orderBy?: OrderByInput,
    ): Promise<{ total: number, data: MyDbEntity[] }> {
        const where = toWhereOptions<MyDbEntityFilter>(
            withRangeFilters(filter),
            MyDbEntityFilter,
        );
        const countQuery = autoCountQuery(MyDbEntity, fields, where);
        const findQuery = autoQuery<FindOptions>(
            MyDbEntity, fields, where,
            toLimitOptions<MyDbEntity>(pageOptions),
            toOrderOptions(orderBy),
        );
        const [total, data] = await Promise.all([
            MyDbEntity.count(countQuery),
            MyDbEntity.findAll(findQuery),
        ]);

        return { total, data } as { total: number, data: MyDbEntity[] };
    }
}
~~~

By doing so, `@cacheBy` will take care of invalidating only those queries
which has selection of fields matching db changes events, so if the actual
query was not selecting some joined data, but there was a change only on that
joined data - cache won't invalidate, as far as real selection was not 
influenced by a data change. And yes, it will automatically monitor
all related to the root model entities for changes and match them with runtime
selections. This makes caching more efficient and more obvious for
developer.

### Extended channels API

~~~typescript
import { cacheWith, ChannelOperation, ChannelPayload } from '@imqueue/pg-cache';

// using simple filtering by operation
@cacheWith({ channels: {
    [MyDbEnity.tableName]: [ChannelOperation.UPDATE, ChannelOperation.INSERT]
}})

// or by using custom filtering function
@cacheWith({ channels: {
    [MyDbEnity.tableName]: (
        payload: ChannelPayload, // payload caught from db event
    ) => payload.operation === ChannelOperation.DELETE,
}})
~~~

## Contributing

Any contributions are greatly appreciated. Feel free to fork, propose PRs, open
issues, do whatever you think may be helpful to this project. PRs which passes
all tests and do not brake tslint rules are first-class candidates to be
accepted!

## License

[ISC](https://github.com/imqueue/pg-pubsub/blob/master/LICENSE)

Happy Coding!
