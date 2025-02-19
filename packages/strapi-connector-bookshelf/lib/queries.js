'use strict';
/**
 * Implementation of model queries for bookshelf
 */

const _ = require('lodash');
const { convertRestQueryParams, buildQuery, models: modelUtils } = require('strapi-utils');

module.exports = function createQueryBuilder({ model, modelKey, strapi }) {
  /* Utils */
  // association key
  const assocKeys = model.associations.map(ast => ast.alias);
  // component keys
  const componentKeys = Object.keys(model.attributes).filter(key => {
    return ['dynamiczone', 'component'].includes(model.attributes[key].type);
  });

  const timestamps = _.get(model, ['options', 'timestamps'], []);

  // Returns an object with relation keys only to create relations in DB
  const pickRelations = values => {
    return _.pick(values, assocKeys);
  };

  // keys to exclude to get attribute keys
  const excludedKeys = assocKeys.concat(componentKeys);
  // Returns an object without relational keys to persist in DB
  const selectAttributes = values => {
    return _.pickBy(values, (value, key) => {
      if (Array.isArray(timestamps) && timestamps.includes(key)) {
        return false;
      }

      return !excludedKeys.includes(key) && _.has(model.allAttributes, key);
    });
  };

  const wrapTransaction = (fn, { transacting } = {}) => {
    const db = strapi.connections[model.connection];
    if (_.get(db,'context.client.config.client') === 'mssql'){
      return fn(transacting);
    }
    if (transacting) return fn(transacting);
    return db.transaction(trx => fn(trx));
  };

  /**
   * Find one entry based on params
   */
  async function findOne(params, populate, { transacting } = {}) {
    const entries = await find({ ...params, _limit: 1 }, populate, { transacting });
    return entries[0] || null;
  }

  /**
   * Find multiple entries based on params
   */
  function find(params, populate, { transacting } = {}) {
    const filters = convertRestQueryParams(params);

    return model
      .query(buildQuery({ model, filters }))
      .fetchAll({
        withRelated: populate,
        transacting,
      })
      .then(results => results.toJSON());
  }

  /**
   * Count entries based on filters
   */
  function count(params = {}) {
    const { where } = convertRestQueryParams(params);

    return model.query(buildQuery({ model, filters: { where } })).count();
  }

  async function create(values, { transacting } = {}) {
    const relations = pickRelations(values);
    const data = selectAttributes(values);

    const runCreate = async trx => {
      // Create entry with no-relational data.
      const entry = await model.forge(data).save(null, { transacting: trx });
      await createComponents(entry, values, { transacting: trx });

      return model.updateRelations({ id: entry.id, values: relations }, { transacting: trx });
    };

    return wrapTransaction(runCreate, { transacting });
  }

  async function update(params, values, { transacting } = {}) {
    const entry = await model.where(params).fetch({ transacting });

    if (!entry) {
      const err = new Error('entry.notFound');
      err.status = 404;
      throw err;
    }

    // Extract values related to relational data.
    const relations = pickRelations(values);
    const data = selectAttributes(values);

    const runUpdate = async trx => {
      const updatedEntry =
        Object.keys(data).length > 0
          ? await entry.save(data, {
              transacting: trx,
              method: 'update',
              patch: true,
            })
          : entry;
      await updateComponents(updatedEntry, values, { transacting: trx });

      if (Object.keys(relations).length > 0) {
        return model.updateRelations({ id: entry.id, values: relations }, { transacting: trx });
      }

      return this.findOne(params, null, { transacting: trx });
    };

    return wrapTransaction(runUpdate, { transacting });
  }

  async function deleteOne(id, { transacting } = {}) {
    const entry = await model.where({ [model.primaryKey]: id }).fetch({ transacting });

    if (!entry) {
      const err = new Error('entry.notFound');
      err.status = 404;
      throw err;
    }

    const values = {};
    model.associations.map(association => {
      switch (association.nature) {
        case 'oneWay':
        case 'oneToOne':
        case 'manyToOne':
        case 'oneToManyMorph':
          values[association.alias] = null;
          break;
        case 'manyWay':
        case 'oneToMany':
        case 'manyToMany':
        case 'manyToManyMorph':
          values[association.alias] = [];
          break;
        default:
      }
    });

    await model.updateRelations({ [model.primaryKey]: id, values }, { transacting });

    const runDelete = async trx => {
      await deleteComponents(entry, { transacting: trx });
      await model.where({ id: entry.id }).destroy({ transacting: trx, require: false });
      return entry.toJSON();
    };

    return wrapTransaction(runDelete, { transacting });
  }

  async function deleteMany(params, { transacting } = {}) {
    if (params[model.primaryKey]) {
      const entries = await find({ ...params, _limit: 1 }, null, { transacting });
      if (entries.length > 0) {
        return deleteOne(entries[0][model.primaryKey], { transacting });
      }
      return null;
    }

    const entries = await find(params, null, { transacting });
    return Promise.all(entries.map(entry => deleteOne(entry.id, { transacting })));
  }

  function search(params, populate) {
    // Convert `params` object to filters compatible with Bookshelf.
    const filters = modelUtils.convertParams(modelKey, params);

    return model
      .query(qb => {
        buildSearchQuery(qb, model, params);

        if (filters.sort) {
          qb.orderBy(filters.sort.key, filters.sort.order);
        }

        if (filters.start) {
          qb.offset(_.toNumber(filters.start));
        }

        if (filters.limit) {
          qb.limit(_.toNumber(filters.limit));
        }
      })
      .fetchAll({
        withRelated: populate,
      })
      .then(results => results.toJSON());
  }

  function countSearch(params) {
    return model
      .query(qb => {
        buildSearchQuery(qb, model, params);
      })
      .count();
  }

  async function createComponents(entry, values, { transacting }) {
    if (componentKeys.length === 0) return;

    const joinModel = model.componentsJoinModel;
    const { foreignKey } = joinModel;

    const createComponentAndLink = async ({ componentModel, value, key, order }) => {
      return strapi
        .query(componentModel.uid)
        .create(value, { transacting })
        .then(component => {
          return joinModel.forge().save(
            {
              [foreignKey]: entry.id,
              component_type: componentModel.collectionName,
              component_id: component.id,
              field: key,
              order,
            },
            { transacting }
          );
        });
    };

    for (let key of componentKeys) {
      const attr = model.attributes[key];
      const { type } = attr;

      switch (type) {
        case 'component': {
          const { component, required = false, repeatable = false } = attr;
          const componentModel = strapi.components[component];

          if (required === true && !_.has(values, key)) {
            const err = new Error(`Component ${key} is required`);
            err.status = 400;
            throw err;
          }

          if (!_.has(values, key)) continue;

          const componentValue = values[key];

          if (repeatable === true) {
            validateRepeatableInput(componentValue, { key, ...attr });
            await Promise.all(
              componentValue.map((value, idx) =>
                createComponentAndLink({
                  componentModel,
                  value,
                  key,
                  order: idx + 1,
                })
              )
            );
          } else {
            validateNonRepeatableInput(componentValue, { key, ...attr });

            if (componentValue === null) continue;
            await createComponentAndLink({
              componentModel,
              key,
              value: componentValue,
              order: 1,
            });
          }
          break;
        }
        case 'dynamiczone': {
          const { required = false } = attr;

          if (required === true && !_.has(values, key)) {
            const err = new Error(`Dynamiczone ${key} is required`);
            err.status = 400;
            throw err;
          }

          if (!_.has(values, key)) continue;

          const dynamiczoneValues = values[key];

          validateDynamiczoneInput(dynamiczoneValues, { key, ...attr });

          await Promise.all(
            dynamiczoneValues.map((value, idx) => {
              const component = value.__component;
              const componentModel = strapi.components[component];
              return createComponentAndLink({
                componentModel,
                value: _.omit(value, ['__component']),
                key,
                order: idx + 1,
              });
            })
          );
          break;
        }
      }
    }
  }

  async function updateComponents(entry, values, { transacting }) {
    if (componentKeys.length === 0) return;

    const joinModel = model.componentsJoinModel;
    const { foreignKey } = joinModel;

    const updateOrCreateComponentAndLink = async ({ componentModel, key, value, order }) => {
      // check if value has an id then update else create
      if (_.has(value, componentModel.primaryKey)) {
        return strapi
          .query(componentModel.uid)
          .update(
            {
              [componentModel.primaryKey]: value[componentModel.primaryKey],
            },
            value,
            { transacting }
          )
          .then(component => {
            return joinModel
              .where({
                [foreignKey]: entry.id,
                component_type: componentModel.collectionName,
                component_id: component.id,
                field: key,
              })
              .save(
                {
                  order,
                },
                { transacting, patch: true, require: false }
              );
          });
      }
      // create
      return strapi
        .query(componentModel.uid)
        .create(value, { transacting })
        .then(component => {
          return joinModel.forge().save(
            {
              [foreignKey]: entry.id,
              component_type: componentModel.collectionName,
              component_id: component.id,
              field: key,
              order,
            },
            { transacting }
          );
        });
    };

    for (let key of componentKeys) {
      // if key isn't present then don't change the current component data
      if (!_.has(values, key)) continue;

      const attr = model.attributes[key];
      const { type } = attr;

      switch (type) {
        case 'component': {
          const { component, repeatable = false } = attr;

          const componentModel = strapi.components[component];

          const componentValue = values[key];

          if (repeatable === true) {
            validateRepeatableInput(componentValue, { key, ...attr });

            await deleteOldComponents(entry, componentValue, {
              key,
              joinModel,
              componentModel,
              transacting,
            });

            await Promise.all(
              componentValue.map((value, idx) => {
                return updateOrCreateComponentAndLink({
                  componentModel,
                  key,
                  value,
                  order: idx + 1,
                });
              })
            );
          } else {
            validateNonRepeatableInput(componentValue, { key, ...attr });

            await deleteOldComponents(entry, componentValue, {
              key,
              joinModel,
              componentModel,
              transacting,
            });

            if (componentValue === null) continue;

            await updateOrCreateComponentAndLink({
              componentModel,
              key,
              value: componentValue,
              order: 1,
            });
          }

          break;
        }
        case 'dynamiczone': {
          const dynamiczoneValues = values[key];

          validateDynamiczoneInput(dynamiczoneValues, { key, ...attr });

          await deleteDynamicZoneOldComponents(entry, dynamiczoneValues, {
            key,
            joinModel,
            transacting,
          });

          await Promise.all(
            dynamiczoneValues.map((value, idx) => {
              const component = value.__component;
              const componentModel = strapi.components[component];
              return updateOrCreateComponentAndLink({
                componentModel,
                value: _.omit(value, ['__component']),
                key,
                order: idx + 1,
              });
            })
          );
          break;
        }
      }
    }
    return;
  }

  async function deleteDynamicZoneOldComponents(entry, values, { key, joinModel, transacting }) {
    const idsToKeep = values.reduce((acc, value) => {
      const component = value.__component;
      const componentModel = strapi.components[component];
      if (_.has(value, componentModel.primaryKey)) {
        acc.push({
          id: value[componentModel.primaryKey].toString(),
          component: componentModel,
        });
      }

      return acc;
    }, []);

    const allIds = await joinModel
      .query(qb => {
        qb.where(joinModel.foreignKey, entry.id).andWhere('field', key);
      })
      .fetchAll({ transacting })
      .map(el => {
        const componentKey = Object.keys(strapi.components).find(
          key => strapi.components[key].collectionName === el.get('component_type')
        );

        return {
          id: el.get('component_id').toString(),
          component: strapi.components[componentKey],
        };
      });

    // verify the provided ids are realted to this entity.
    idsToKeep.forEach(({ id, component }) => {
      if (!allIds.find(el => el.id === id && el.component.uid === component.uid)) {
        const err = new Error(
          `Some of the provided components in ${key} are not related to the entity`
        );
        err.status = 400;
        throw err;
      }
    });

    const idsToDelete = allIds.reduce((acc, { id, component }) => {
      if (!idsToKeep.find(el => el.id === id && el.component.uid === component.uid)) {
        acc.push({
          id,
          component,
        });
      }
      return acc;
    }, []);

    if (idsToDelete.length > 0) {
      await joinModel
        .query(qb => {
          qb.where('field', key);
          qb.where(qb => {
            idsToDelete.forEach(({ id, component }) => {
              qb.orWhere(qb => {
                qb.where('component_id', id).andWhere('component_type', component.collectionName);
              });
            });
          });
        })
        .destroy({ transacting });

      for (const idToDelete of idsToDelete) {
        const { id, component } = idToDelete;
        const model = strapi.query(component.uid);
        await model.delete({ [model.primaryKey]: id }, { transacting });
      }
    }
  }

  async function deleteOldComponents(
    entry,
    componentValue,
    { key, joinModel, componentModel, transacting }
  ) {
    const componentArr = Array.isArray(componentValue) ? componentValue : [componentValue];

    const idsToKeep = componentArr
      .filter(el => _.has(el, componentModel.primaryKey))
      .map(el => el[componentModel.primaryKey].toString());

    const allIds = await joinModel
      .where({
        [joinModel.foreignKey]: entry.id,
        field: key,
      })
      .fetchAll({ transacting })
      .map(el => el.get('component_id').toString());

    // verify the provided ids are realted to this entity.
    idsToKeep.forEach(id => {
      if (!allIds.includes(id)) {
        const err = new Error(
          `Some of the provided components in ${key} are not related to the entity`
        );
        err.status = 400;
        throw err;
      }
    });

    const idsToDelete = _.difference(allIds, idsToKeep);
    if (idsToDelete.length > 0) {
      await joinModel
        .query(qb => qb.whereIn('component_id', idsToDelete).andWhere('field', key))
        .destroy({ transacting, require: false });

      await strapi
        .query(componentModel.uid)
        .delete({ [`${componentModel.primaryKey}_in`]: idsToDelete }, { transacting });
    }
  }

  async function deleteComponents(entry, { transacting }) {
    if (componentKeys.length === 0) return;

    const joinModel = model.componentsJoinModel;
    const { foreignKey } = joinModel;

    for (let key of componentKeys) {
      const attr = model.attributes[key];
      const { type } = attr;

      switch (type) {
        case 'component': {
          const { component } = attr;

          const componentModel = strapi.components[component];

          const ids = await joinModel
            .where({
              [foreignKey]: entry.id,
              field: key,
            })
            .fetchAll({ transacting })
            .map(el => el.get('component_id'));

          await strapi
            .query(componentModel.uid)
            .delete({ [`${componentModel.primaryKey}_in`]: ids }, { transacting });

          await joinModel
            .where({
              [foreignKey]: entry.id,
              field: key,
            })
            .destroy({ transacting, require: false });
          break;
        }
        case 'dynamiczone': {
          const { components } = attr;

          const componentJoins = await joinModel
            .where({
              [foreignKey]: entry.id,
              field: key,
            })
            .fetchAll({ transacting })
            .map(el => ({
              id: el.get('component_id'),
              componentType: el.get('component_type'),
            }));

          for (const compo of components) {
            const { uid, collectionName } = strapi.components[compo];
            const model = strapi.query(uid);

            const toDelete = componentJoins.filter(el => el.componentType === collectionName);

            if (toDelete.length > 0) {
              await model.delete(
                {
                  [`${model.primaryKey}_in`]: toDelete.map(el => el.id),
                },
                { transacting }
              );
            }
          }

          await joinModel
            .where({
              [foreignKey]: entry.id,
              field: key,
            })
            .destroy({ transacting, require: false });

          break;
        }
      }
    }
  }

  return {
    findOne,
    find,
    create,
    update,
    delete: deleteMany,
    count,
    search,
    countSearch,
  };
};

/**
 * util to build search query
 * @param {*} qb
 * @param {*} model
 * @param {*} params
 */
const buildSearchQuery = (qb, model, params) => {
  const query = params._q;

  const associations = model.associations.map(x => x.alias);

  const searchText = Object.keys(model._attributes)
    .filter(attribute => attribute !== model.primaryKey && !associations.includes(attribute))
    .filter(attribute => ['string', 'text'].includes(model._attributes[attribute].type));

  const searchInt = Object.keys(model._attributes)
    .filter(attribute => attribute !== model.primaryKey && !associations.includes(attribute))
    .filter(attribute =>
      ['integer', 'decimal', 'float'].includes(model._attributes[attribute].type)
    );

  const searchBool = Object.keys(model._attributes)
    .filter(attribute => attribute !== model.primaryKey && !associations.includes(attribute))
    .filter(attribute => ['boolean'].includes(model._attributes[attribute].type));

  if (!_.isNaN(_.toNumber(query))) {
    searchInt.forEach(attribute => {
      qb.orWhere(attribute, _.toNumber(query));
    });
  }

  if (query === 'true' || query === 'false') {
    searchBool.forEach(attribute => {
      qb.orWhere(attribute, _.toNumber(query === 'true'));
    });
  }

  // Search in columns with text using index.
  switch (model.client) {
    case 'mysql':
      qb.orWhereRaw(`MATCH(${searchText.join(',')}) AGAINST(? IN BOOLEAN MODE)`, `*${query}*`);
      break;
    case 'pg': {
      const searchQuery = searchText.map(attribute =>
        _.toLower(attribute) === attribute
          ? `to_tsvector(coalesce(${attribute}, ''))`
          : `to_tsvector(coalesce("${attribute}", ''))`
      );

      qb.orWhereRaw(`${searchQuery.join(' || ')} @@ plainto_tsquery(?)`, query);
      break;
    }
  }
};

function validateRepeatableInput(value, { key, min, max, required }) {
  if (!Array.isArray(value)) {
    const err = new Error(`Component ${key} is repetable. Expected an array`);
    err.status = 400;
    throw err;
  }

  value.forEach(val => {
    if (typeof val !== 'object' || Array.isArray(val) || val === null) {
      const err = new Error(
        `Component ${key} has invalid items. Expected each items to be objects`
      );
      err.status = 400;
      throw err;
    }
  });

  if ((required === true || (required !== true && value.length > 0)) && min && value.length < min) {
    const err = new Error(`Component ${key} must contain at least ${min} items`);
    err.status = 400;
    throw err;
  }

  if (max && value.length > max) {
    const err = new Error(`Component ${key} must contain at most ${max} items`);
    err.status = 400;
    throw err;
  }
}

function validateNonRepeatableInput(value, { key, required }) {
  if (typeof value !== 'object' || Array.isArray(value)) {
    const err = new Error(`Component ${key} should be an object`);
    err.status = 400;
    throw err;
  }

  if (required === true && value === null) {
    const err = new Error(`Component ${key} is required`);
    err.status = 400;
    throw err;
  }
}

function validateDynamiczoneInput(value, { key, min, max, components, required }) {
  if (!Array.isArray(value)) {
    const err = new Error(`Dynamiczone ${key} is invalid. Expected an array`);
    err.status = 400;
    throw err;
  }

  value.forEach(val => {
    if (typeof val !== 'object' || Array.isArray(val) || val === null) {
      const err = new Error(
        `Dynamiczone ${key} has invalid items. Expected each items to be objects`
      );
      err.status = 400;
      throw err;
    }

    if (!_.has(val, '__component')) {
      const err = new Error(
        `Dynamiczone ${key} has invalid items. Expected each items to have a valid __component key`
      );
      err.status = 400;
      throw err;
    } else if (!components.includes(val.__component)) {
      const err = new Error(
        `Dynamiczone ${key} has invalid items. Each item must have a __component key that is present in the attribute definition`
      );
      err.status = 400;
      throw err;
    }
  });

  if ((required === true || (required !== true && value.length > 0)) && min && value.length < min) {
    const err = new Error(`Dynamiczone ${key} must contain at least ${min} items`);
    err.status = 400;
    throw err;
  }
  if (max && value.length > max) {
    const err = new Error(`Dynamiczone ${key} must contain at most ${max} items`);
    err.status = 400;
    throw err;
  }
}
