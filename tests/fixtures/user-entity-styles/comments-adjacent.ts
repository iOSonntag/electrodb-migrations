import { Entity } from 'electrodb';

export const User = new Entity({
  model: {
    entity: 'User',
    service: 'app',
    // bump me carefully
    version: '1', /* keep this comment */
  },
  attributes: { id: { type: 'string', required: true } },
  indexes: { primary: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
});
