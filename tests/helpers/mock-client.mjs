// Piccolo adapter del contratto PostgREST, condiviso dai test e dall'anteprima.
// Non viene importato dall'app né incluso nel pacchetto Android.
export function mockClient(respond) {
  return {
    from(table) {
      const request = { table, operation: 'select', filters: [], orders: [] };
      const query = {
        select(columns = '*') { request.columns = columns; return query; },
        insert(payload) { request.operation = 'insert'; request.payload = payload; return query; },
        update(payload) { request.operation = 'update'; request.payload = payload; return query; },
        upsert(payload) { request.operation = 'upsert'; request.payload = payload; return query; },
        delete() { request.operation = 'delete'; return query; },
        single() { request.single = true; return query; },
        maybeSingle() { request.maybeSingle = true; return query; },
        order(column, options) { request.orders.push({ column, ...options }); return query; },
        limit(value) { request.limit = value; return query; },
        then(resolve, reject) { return Promise.resolve().then(() => respond(request)).then(resolve, reject); },
      };
      for (const operator of ['eq', 'in', 'gte', 'lte', 'gt']) {
        query[operator] = (column, value) => {
          request.filters.push({ operator, column, value });
          return query;
        };
      }
      return query;
    },
  };
}
