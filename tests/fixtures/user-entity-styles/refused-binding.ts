import { Entity } from 'electrodb';

const VERSION = '1';

export const User = new Entity({
  model: { entity: 'User', service: 'app', version: VERSION },
  attributes: { id: { type: 'string', required: true } },
  indexes: { primary: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
});
