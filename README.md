# @imqueue/pg-cache

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

With the setup, descibed above first call to `MyCoolService.listEntities()` will
save method return value to cache and each next call will return cached value,
stored in redis instead of making database query.
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
        args: any[],             // method runtime arguments
    ) => payload.record.id === args.id,
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
