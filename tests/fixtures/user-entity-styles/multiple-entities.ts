import { Entity } from 'electrodb';

export const User = new Entity({
  model: { entity: 'User', service: 'app', version: '1' },
  attributes: {
    id: { type: 'string', required: true },
  },
  indexes: {
    primary: {
      pk: { field: 'pk', composite: ['id'] },
      sk: { field: 'sk', composite: [] },
    },
  },
});

export const Team = new Entity({
  model: { entity: 'Team', service: 'app', version: '1' },
  attributes: {
    id: { type: 'string', required: true },
  },
  indexes: {
    primary: {
      pk: { field: 'pk', composite: ['id'] },
      sk: { field: 'sk', composite: [] },
    },
  },
});
