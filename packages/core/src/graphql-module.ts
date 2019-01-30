import { IResolvers, makeExecutableSchema, SchemaDirectiveVisitor, ILogger, mergeSchemas, IDirectiveResolvers, IResolverValidationOptions } from 'graphql-tools';
import { mergeGraphQLSchemas, mergeResolvers } from 'graphql-toolkit';
import { Provider, Injector, ProviderScope } from '@graphql-modules/di';
import { DocumentNode, GraphQLSchema, parse, GraphQLScalarType, buildASTSchema } from 'graphql';
import { IResolversComposerMapping, composeResolvers } from './resolvers-composition';
import { DepGraph } from 'dependency-graph';
import { DependencyModuleNotFoundError, SchemaNotValidError, DependencyModuleUndefinedError, TypeDefNotFoundError, ModuleConfigRequiredError, IllegalResolverInvocationError, ContextBuilderError } from './errors';
import * as deepmerge from 'deepmerge';
import { ModuleSessionInfo } from './module-session-info';
import { asArray } from './utils';
import { ModuleContext, ISubscriptionHooks } from './types';

/**
 * A context builder method signature for `contextBuilder`.
 */
export type BuildContextFn<Config, Session, Context> = (
  session: Session,
  currentContext: ModuleContext<any>,
  moduleSessionInfo: ModuleSessionInfo<Config, Session, Context>,
) => Promise<Context> | Context;

export interface ISchemaDirectives {
  [name: string]: typeof SchemaDirectiveVisitor;
}

export type ModulesMap<Session> = Map<string, GraphQLModule<any, Session, any>>;

/**
 * Defines the structure of a dependency as it declared in each module's `dependencies` field.
 */
export type ModuleDependency<Config, Session, Context> = GraphQLModule<Config, Session, Context> | string;

export type GraphQLModuleOption<Option, Config, Session, Context> = Option | ((module: GraphQLModule<Config, Session, Context>, ...args: any[]) => Option);

export type GraphQLModuleMiddleware<Session, Context>
 = (moduleCache: ModuleCache<Session, Context>) => Partial<ModuleCache<Session, Context>> | void;

export interface KeyValueCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

/**
 * Defined the structure of GraphQL module options object.
 */
export interface GraphQLModuleOptions<Config, Session, Context> {
  /**
   * The name of the module. Use it later to get your `ModuleConfig(name)` or to declare
   * a dependency to this module (in another module)
   */
  name?: string;
  /**
   * A definition of GraphQL type definitions, as string or `DocumentNode`.
   * Arrays are also accepted, and they will get merged.
   * You can also pass a function that will get the module's config as argument, and should return
   * the type definitions.
   */
  typeDefs?: GraphQLModuleOption<string | string[] | DocumentNode | DocumentNode[], Config, Session, Context>;
  /**
   * Resolvers object, or a function will get the module's config as argument, and should
   * return the resolvers object.
   */
  resolvers?: GraphQLModuleOption<IResolvers<any, ModuleContext<Context>>, Config, Session, Context>;
  /**
   * Context builder method. Use this to add your own fields and data to the GraphQL `context`
   * of each execution of GraphQL.
   */
  context?: BuildContextFn<Config, Session, Context> | Promise<Context> | Context;
  /**
   * The dependencies that this module need to run correctly, you can either provide the `GraphQLModule`,
   * or provide a string with the name of the other module.
   * Adding a dependency will effect the order of the type definition building, resolvers building and context
   * building.
   */
  imports?: GraphQLModuleOption<Array<ModuleDependency<any, Session, any>>, Config, Session, Context>;
  /**
   * A list of `Providers` to load into the GraphQL module.
   * It could be either a `class` or a value/class instance.
   * All loaded class will be loaded as Singletons, and the instance will be
   * shared across all GraphQL executions.
   */
  providers?: GraphQLModuleOption<Provider[], Config, Session, Context>;
  /** Object map between `Type.field` to a function(s) that will wrap the resolver of the field  */
  resolversComposition?: GraphQLModuleOption<IResolversComposerMapping, Config, Session, Context>;
  schemaDirectives?: GraphQLModuleOption<ISchemaDirectives, Config, Session, Context>;
  directiveResolvers?: GraphQLModuleOption<IDirectiveResolvers, Config, Session, Context>;
  logger?: GraphQLModuleOption<ILogger, Config, Session, Context>;
  extraSchemas?: GraphQLModuleOption<GraphQLSchema[], Config, Session, Context>;
  middleware?: GraphQLModuleMiddleware<Session, Context>;
  cache?: KeyValueCache;
  mergeCircularImports?: boolean;
  warnCircularImports?: boolean;
  configRequired?: boolean;
  resolverValidationOptions?: GraphQLModuleOption<IResolverValidationOptions, Config, Session, Context>;
}

/**
 * Returns a dependency injection token for getting a module's configuration object by
 * the module's name.
 * You can use this later with `@Inject` in your `Provider`s.
 *
 * @param module
 * @constructor
 */
export const ModuleConfig = (module: string | GraphQLModule) =>
  Symbol.for(`ModuleConfig.${typeof module === 'string' ? module : module.name}`);

export interface ModuleCache<Session, Context> {
  injector: Injector;
  schema: GraphQLSchema;
  typeDefs: DocumentNode;
  resolvers: IResolvers<any, ModuleContext<Context>>;
  schemaDirectives: ISchemaDirectives;
  contextBuilder: (session: Session, excludeSession?: boolean) => Promise<ModuleContext<Context>>;
  modulesMap: ModulesMap<Session>;
  extraSchemas: GraphQLSchema[];
  directiveResolvers: IDirectiveResolvers;
  subscriptionHooks: ISubscriptionHooks;
}

/**
 * Represents a GraphQL module that has it's own types, resolvers, context and business logic.
 * You can read more about it in the Documentation section. {@link /docs/introduction/modules}
 *
 * You can also specific `Config` generic to tell TypeScript what's the structure of your
 * configuration object to use later with `forRoot`
 */
export class GraphQLModule<Config = any, Session = any, Context = any> {

  private _cache: ModuleCache<Session, Context> = {
    injector: undefined,
    schema: undefined,
    typeDefs: undefined,
    resolvers: undefined,
    schemaDirectives: undefined,
    contextBuilder: undefined,
    modulesMap: undefined,
    extraSchemas: undefined,
    directiveResolvers: undefined,
    subscriptionHooks: undefined,
  };

  /**
   * Creates a new `GraphQLModule` instance, merged it's type definitions and resolvers.
   * @param options - module configuration
   */
  constructor(
    private _options: GraphQLModuleOptions<Config, Session, Context> = {},
    private _moduleConfig?: Config,
  ) {
    _options.name = _options.name || Math.floor(Math.random() * Math.floor(Number.MAX_SAFE_INTEGER)).toString();
    if (!('mergeCircularImports' in _options)) {
      _options.mergeCircularImports = true;
    }
    if (!('warnCircularImports' in _options)) {
      _options.warnCircularImports = true;
    }
    if (!('logger' in _options)) {
      _options.logger = {
        log() { },
      };
    }
    if (!('cache' in _options)) {
      const storage = new Map<string, any>();
      _options.cache = {
        get: async key => storage.get(key),
        set: async (key, value) => { storage.set(key, value); },
        delete: async key => storage.delete(key),
      };
    }
  }

  /**
   * Creates another instance of the module using a configuration
   * @param config - the config object
   */
  forRoot(config: Config): GraphQLModule<Config, Session, Context> {
    return new GraphQLModule<Config, Session, Context>(this._options, config);
  }

  forChild(): string {
    return this.name;
  }

  private checkConfiguration() {
    if (this._options.configRequired && !this._moduleConfig) {
      throw new ModuleConfigRequiredError(this.name);
    }
  }

  get name() {
    return this._options.name;
  }

  get config() {
    return this._moduleConfig;
  }

  private fixCacheForModulesMap(modulesMap: ModulesMap<Session>, fieldName?: keyof ModuleCache<Session, Context>) {
    if (this._cache.modulesMap !== modulesMap) {
      this._cache.modulesMap = modulesMap;
      if (fieldName) {
        this._cache[fieldName] = undefined;
      }
    }
  }

  get directiveResolvers(): IDirectiveResolvers {
    if (typeof this._cache.directiveResolvers === 'undefined') {
      this.checkConfiguration();
      const modulesMap = this.modulesMap;
      const directiveResolversSet = new Set<IDirectiveResolvers>();
      this.iterateOverImports(module => {
        module.fixCacheForModulesMap(modulesMap, 'directiveResolvers');
        const moduleDirectiveResolvers = module.directiveResolvers;
        if (moduleDirectiveResolvers) {
          directiveResolversSet.add(moduleDirectiveResolvers);
        }
      });
      const selfDirectiveResolvers = this.selfDirectiveResolvers;
      if (selfDirectiveResolvers) {
        directiveResolversSet.add(selfDirectiveResolvers);
      }
      this._cache.directiveResolvers = deepmerge.all([...directiveResolversSet]) as IDirectiveResolvers;
    }
    return this._cache.directiveResolvers;
  }

  buildSchemaWithMergeSchemas() {
    const modulesMap = this.modulesMap;
    const schemaSet = new Set<GraphQLSchema>();
    this.iterateOverImports(module => {
      module.fixCacheForModulesMap(modulesMap, 'schema');
      const moduleSchema = module.schema;
      if (moduleSchema) {
        schemaSet.add(moduleSchema);
      }
    });
    const selfTypeDefs = this.selfTypeDefs;
    if (selfTypeDefs) {
      schemaSet.add(buildASTSchema(selfTypeDefs, {
        assumeValid: true,
        assumeValidSDL: true,
      }));
    }
    const selfExtraSchemas = this.selfExtraSchemas;
    const selfResolvers = this.addSessionInjectorToSelfResolversContext();
    const selfResolversComposition = this.addSessionInjectorToSelfResolversCompositionContext();
    const selfComposedResolvers = composeResolvers(
      selfResolvers,
      selfResolversComposition,
    );
    const selfSchemaDirectives = this.selfSchemaDirectives;
    this._cache.schema = mergeSchemas({
      schemas: [ ...selfExtraSchemas, ...schemaSet],
      resolvers: selfComposedResolvers,
      schemaDirectives: selfSchemaDirectives,
    });
  }

  buildSchemaWithMakeExecutableSchema() {
    try {
      const typeDefs = this.typeDefs;
      const resolvers = this.resolvers;
      const schemaDirectives = this.schemaDirectives;
      const directiveResolvers = this.directiveResolvers;
      const logger = this.selfLogger;
      const resolverValidationOptions = this.selfResolverValidationOptions;
      const extraSchemas = this.extraSchemas;
      if (typeDefs) {
        const localSchema = makeExecutableSchema<ModuleContext<Context>>({
          typeDefs,
          resolvers,
          schemaDirectives,
          directiveResolvers,
          logger,
          resolverValidationOptions,
        });
        if (extraSchemas.length) {
          this._cache.schema = mergeSchemas({
            schemas: [localSchema, ...extraSchemas],
          });
        } else {
          this._cache.schema = localSchema;
        }
      }
    } catch (e) {
      if (e.message !== 'Must provide typeDefs') {
        if (e.message.includes(`Type "`) && e.message.includes(`" not found in document.`)) {
          const typeDef = e.message.replace('Type "', '').replace('" not found in document.', '');
          throw new TypeDefNotFoundError(typeDef, this.name);
        } else {
          throw new SchemaNotValidError(this.name, e.message);
        }
      } else {
        this._cache.schema = null;
      }
    }
  }

  /**
   * Gets the application `GraphQLSchema` object.
   * If the schema object is not built yet, it compiles
   * the `typeDefs` and `resolvers` into `GraphQLSchema`
   */
  get schema() {
    if (typeof this._cache.schema === 'undefined') {
      this.checkConfiguration();
      this.buildSchemaWithMakeExecutableSchema();
      if ('middleware' in this._options) {
        const middlewareResult = this._options.middleware(this._cache);
        this._cache = Object.assign(this._cache, middlewareResult);
      }
    }
    return this._cache.schema;
  }

  /**
   * Gets the application dependency-injection injector
   */
  get injector(): Injector {
    if (typeof this._cache.injector === 'undefined') {
      this.checkConfiguration();
      const modulesMap = this.modulesMap;
      const injectorsSet = new Set<Injector>();
      this.iterateOverImports(module => {
        module.fixCacheForModulesMap(modulesMap, 'injector');
        const moduleInjector = module.injector;
        injectorsSet.add(moduleInjector);
      });
      const injector = this._cache.injector = new Injector(
        this.name,
        ProviderScope.Application,
        injectorsSet,
      );

      injector.provide({
        provide: GraphQLModule,
        useValue: this,
      });

      const selfProviders = this.selfProviders;

      for (const provider of selfProviders) {
        injector.provide(provider);
      }

      for (const serviceIdentifier of injector.scopeSet) {
        injector.get(serviceIdentifier);
      }
    }
    return this._cache.injector;
  }

  get cache(): KeyValueCache {
    return this._options.cache;
  }

  get extraSchemas(): GraphQLSchema[] {
    if (typeof this._cache.extraSchemas) {
      this.checkConfiguration();
      const modulesMap = this.modulesMap;
      const extraSchemasSet = new Set<GraphQLSchema>();
      this.iterateOverImports(module => {
        module.fixCacheForModulesMap(modulesMap, 'extraSchemas');
        const moduleExtraSchemas = module.extraSchemas;
        if (moduleExtraSchemas) {
          moduleExtraSchemas.forEach(extraSchema => extraSchemasSet.add(extraSchema));
        }
      });
      const selfExtraSchemas = this.selfExtraSchemas;
      if (selfExtraSchemas) {
        selfExtraSchemas.forEach(extraSchema => extraSchemasSet.add(extraSchema));
      }
      this._cache.extraSchemas = [...extraSchemasSet];
    }
    return this._cache.extraSchemas;
  }

  /**
   * Gets the merged GraphQL type definitions as one string
   */
  get typeDefs(): DocumentNode {
    if (typeof this._cache.typeDefs === 'undefined') {
      this.checkConfiguration();
      const modulesMap = this.modulesMap;
      const typeDefsSet = new Set<DocumentNode>();
      this.iterateOverImports(module => {
        module.fixCacheForModulesMap(modulesMap, 'typeDefs');
        const moduleTypeDefs = module.typeDefs;
        if (moduleTypeDefs) {
          typeDefsSet.add(moduleTypeDefs);
        }
      });
      const selfTypeDefs = this.selfTypeDefs;
      if (selfTypeDefs) {
        typeDefsSet.add(selfTypeDefs);
      }
      const extraSchemas = this.extraSchemas;
      this._cache.typeDefs = mergeGraphQLSchemas([...typeDefsSet, ...extraSchemas], {
        useSchemaDefinition: false,
      });
    }
    return this._cache.typeDefs;
  }

  private iterateOverImports(callback: (module: GraphQLModule<any, any, any>) => any) {
    const modulesMap = this.modulesMap;
    const selfImports = this.selfImports;
    for (let module of selfImports) {
      const moduleName = typeof module === 'string' ? module : module.name;
      module = modulesMap.get(moduleName);
      callback(module);
    }
  }

  get resolvers(): IResolvers<any, ModuleContext<Context>> {
    if (typeof this._cache.resolvers === 'undefined') {
      this.checkConfiguration();
      const modulesMap = this.modulesMap;
      const resolversToBeComposed = new Set<IResolvers>();
      this.iterateOverImports(module => {
        module.fixCacheForModulesMap(modulesMap, 'resolvers');
        const moduleResolvers = module.resolvers;
        if (moduleResolvers) {
          resolversToBeComposed.add(moduleResolvers);
        }
      });
      const resolvers = this.addSessionInjectorToSelfResolversContext();
      const resolversComposition = this.addSessionInjectorToSelfResolversCompositionContext();
      resolversToBeComposed.add(resolvers);
      const composedResolvers = composeResolvers<any, ModuleContext<Context>>(
        mergeResolvers([...resolversToBeComposed]),
        resolversComposition,
      );
      this._cache.resolvers = composedResolvers;
    }
    return this._cache.resolvers;
  }

  get schemaDirectives(): ISchemaDirectives {
    if (typeof this._cache.schemaDirectives === 'undefined') {
      this.checkConfiguration();
      const modulesMap = this.modulesMap;
      const schemaDirectivesSet = new Set<ISchemaDirectives>();
      this.iterateOverImports(module => {
        module.fixCacheForModulesMap(modulesMap, 'schemaDirectives');
        const moduleSchemaDirectives = module.schemaDirectives;
        if (moduleSchemaDirectives) {
          schemaDirectivesSet.add(moduleSchemaDirectives);
        }
      });
      const selfSchemaDirectives = this.selfSchemaDirectives;
      if (selfSchemaDirectives) {
        schemaDirectivesSet.add(selfSchemaDirectives);
      }
      this._cache.schemaDirectives = deepmerge.all([...schemaDirectivesSet]) as ISchemaDirectives;
    }
    return this._cache.schemaDirectives;
  }

  get subscriptions(): ISubscriptionHooks {
    if (typeof this._cache.subscriptionHooks === 'undefined') {
      const modulesMap = this.modulesMap;
      const subscriptionHooksSet = new Set<ISubscriptionHooks>();
      this.iterateOverImports(module => {
        module.fixCacheForModulesMap(modulesMap, 'subscriptionHooks');
        const moduleSubscriptionHooks = module.subscriptions;
        if (moduleSubscriptionHooks) {
          subscriptionHooksSet.add(moduleSubscriptionHooks);
        }
      });
      this._cache.subscriptionHooks = {
        onConnect: async (connectionParams, websocket, connectionSession) => {
          const importsOnConnectHooks$ = [...subscriptionHooksSet].map(async ({ onConnect }) => onConnect && onConnect(connectionParams, websocket, connectionSession));
          const importsOnConnectHooks = await Promise.all(importsOnConnectHooks$);
          const importsResult = importsOnConnectHooks.reduce((acc, curr) => ({ ...acc, ...(curr || {}) }), {});
          const connectionContext = await this.context(connectionSession);
          const applicationInjector = this.injector;
          const sessionInjector = connectionContext.injector;
          const sessionHooks$ = [
            ...applicationInjector.scopeSet,
            ...sessionInjector.scopeSet,
          ].map(serviceIdentifier => sessionInjector.callHookWithArgs('onConnect', serviceIdentifier, connectionParams, websocket, connectionContext),
          );
          const results = await Promise.all(sessionHooks$);
          const hookResult = results.reduce((acc, curr) => ({ ...acc, ...(curr || {}) }), {});
          const finalResult = {
            ...importsResult,
            ...connectionContext,
            ...hookResult,
          };
          const moduleNameContextMap = this.getModuleNameContextMap(connectionSession);
          moduleNameContextMap.set(this.name, finalResult);
          return finalResult;
        },
        onDisconnect: async (websocket, connectionSession) => {
          const importsOnDisconnectHooks$ = [...subscriptionHooksSet].map(async ({ onDisconnect }) => onDisconnect && onDisconnect(websocket, connectionSession));
          const importsOnDisconnectHooks = await Promise.all(importsOnDisconnectHooks$);
          const importsResult = importsOnDisconnectHooks.reduce((acc, curr) => ({ ...acc, ...(curr || {}) }), {});
          const connectionContext = await this.context(connectionSession);
          const applicationInjector = this.injector;
          const sessionInjector = connectionContext.injector;
          const sessionHooks$ = [
            ...applicationInjector.scopeSet,
            ...sessionInjector.scopeSet,
          ].map(serviceIdentifier => sessionInjector.callHookWithArgs('onDisconnect', serviceIdentifier, websocket, connectionContext),
          );
          const results = await Promise.all(sessionHooks$);
          const hookResult = results.reduce((acc, curr) => ({ ...acc, ...(curr || {}) }), {});
          const finalResult = {
            ...importsResult,
            ...connectionContext,
            ...hookResult,
          };
          const moduleNameContextMap = this.getModuleNameContextMap(connectionSession);
          moduleNameContextMap.set(this.name, finalResult);
          return finalResult;
        },
      };
    }
    return this._cache.subscriptionHooks;
  }

  get selfExtraSchemas(): GraphQLSchema[] {
    let extraSchemas = new Array<GraphQLSchema>();
    const extraSchemasDefinitions = this._options.extraSchemas;
    if (extraSchemasDefinitions) {
      if (typeof extraSchemasDefinitions === 'function') {
        extraSchemas = extraSchemasDefinitions(this);
      } else {
        extraSchemas = extraSchemasDefinitions;
      }
    }
    return extraSchemas;
  }

  /**
   * Returns the GraphQL type definitions of the module
   * @return a `string` with the merged type definitions
   */
  get selfTypeDefs(): DocumentNode {
    let typeDefs = null;
    let typeDefsDefinitions = this._options.typeDefs;
    if (typeDefsDefinitions) {
      if (typeof typeDefsDefinitions === 'function') {
        typeDefsDefinitions = typeDefsDefinitions(this);
      }
      if (typeof typeDefsDefinitions === 'string') {
        typeDefs = parse(typeDefsDefinitions);
      } else if (Array.isArray(typeDefsDefinitions)) {
        typeDefs = mergeGraphQLSchemas(typeDefsDefinitions, {
          useSchemaDefinition: false,
        });
      } else if (typeDefsDefinitions) {
        typeDefs = typeDefsDefinitions;
      }
    }
    return typeDefs;
  }

  get selfResolvers(): IResolvers<any, ModuleContext<Context>> {
    let resolvers: IResolvers<any, ModuleContext<Context>> = {};
    const resolversDefinitions = this._options.resolvers;
    if (resolversDefinitions) {
      if (typeof resolversDefinitions === 'function') {
        resolvers = this.injector.call(resolversDefinitions, this);
      } else {
        resolvers = resolversDefinitions;
      }
    }
    return resolvers;
  }

  get selfImports() {
    let imports = new Array<ModuleDependency<any, any, any>>();
    if (this._options.imports) {
      if (typeof this._options.imports === 'function') {
        imports = this._options.imports(this);
      } else {
        imports = this._options.imports;
      }
    }
    return imports;
  }

  get selfProviders(): Provider[] {
    let providers = new Array<Provider>();
    const providersDefinitions = this._options.providers;
    if (providersDefinitions) {
      if (typeof providersDefinitions === 'function') {
        providers = providersDefinitions(this);
      } else {
        providers = providersDefinitions;
      }
    }
    return [
      {
        provide: ModuleConfig(this),
        useValue: this.config,
      },
      ...providers,
    ];
  }

  get selfResolversComposition(): IResolversComposerMapping {
    let resolversComposition: IResolversComposerMapping = {};
    const resolversCompositionDefinitions = this._options.resolversComposition;
    if (resolversCompositionDefinitions) {
      if (resolversCompositionDefinitions instanceof Function) {
        resolversComposition = this.injector.call(resolversCompositionDefinitions, this);
      } else {
        resolversComposition = resolversCompositionDefinitions;
      }
    }
    return resolversComposition;
  }

  get selfSchemaDirectives(): ISchemaDirectives {
    let schemaDirectives: ISchemaDirectives = {};
    const schemaDirectivesDefinitions = this._options.schemaDirectives;
    if (schemaDirectivesDefinitions) {
      if (typeof schemaDirectivesDefinitions === 'function') {
        schemaDirectives = this.injector.call(schemaDirectivesDefinitions, this);
      } else {
        schemaDirectives = schemaDirectivesDefinitions;
      }
    }
    return schemaDirectives;
  }

  get selfDirectiveResolvers(): IDirectiveResolvers {
    let directiveResolvers: IDirectiveResolvers = {};
    const directiveResolversDefinitions = this._options.directiveResolvers;
    if (directiveResolversDefinitions) {
      if (typeof directiveResolversDefinitions === 'function') {
        directiveResolvers = this.injector.call(directiveResolversDefinitions, this);
      } else {
        directiveResolvers = directiveResolversDefinitions;
      }
    }
    return directiveResolvers;
  }

  private checkIfResolverCalledSafely(resolverPath: string, session: any, info: any) {
    if (typeof session === 'undefined') {
      throw new IllegalResolverInvocationError(resolverPath, this.name, `Network Session hasn't been passed!`);
    }
    if (typeof info === 'undefined') {
      throw new IllegalResolverInvocationError(resolverPath, this.name, `GraphQL Resolve Information hasn't been passed!`);
    }
  }

  private addSessionInjectorToSelfResolversContext() {
    const resolvers = this.selfResolvers;
    // tslint:disable-next-line:forin
    for (const type in resolvers) {
      const typeResolvers = resolvers[type];
      if (!(typeResolvers instanceof GraphQLScalarType)) {
        // tslint:disable-next-line:forin
        for (const prop in resolvers[type]) {
          const resolver = typeResolvers[prop];
          if (typeof resolver === 'function') {
            if (prop !== '__resolveType') {
              typeResolvers[prop] = async (root: any, args: any, appContext: any, info: any) => {
                const session = info.session || appContext.session;
                info.session = session;
                this.checkIfResolverCalledSafely(`${type}.${prop}`, session, info);
                let moduleContext;
                try {
                  moduleContext = await this.context(session, true);
                } catch (e) {
                  console.error(e);
                  throw e;
                }
                info.schema = this.schema;
                return resolver.call(typeResolvers[prop], root, args, moduleContext, info);
              };
            } else {
              typeResolvers[prop] = async (root: any, appContext: any, info: any) => {
                const session = info.session || appContext.session;
                info.session = session;
                this.checkIfResolverCalledSafely(`${type}.${prop}`, session, info);
                let moduleContext;
                try {
                  moduleContext = await this.context(session, true);
                } catch (e) {
                  console.error(e);
                  throw e;
                }
                info.schema = this.schema;
                return resolver.call(typeResolvers, root, moduleContext, info);
              };
            }
          } else if ('subscribe' in resolver) {
            const subscriber = resolver['subscribe'];
            typeResolvers[prop]['subscribe'] = async (root: any, args: any, appContext: any, info: any) => {
              const session = info.session || appContext.session;
              info.session = session;
              this.checkIfResolverCalledSafely(`${type}.${prop}`, session, info);
              let moduleContext;
              try {
                moduleContext = await this.context(session, true);
              } catch (e) {
                console.error(e);
                throw e;
              }
              info.schema = this.schema;
              return subscriber.call(typeResolvers[prop], root, args, moduleContext, info);
            };
          }
        }
      }
    }
    return resolvers;
  }

  private addSessionInjectorToSelfResolversCompositionContext() {
    const resolversComposition = this.selfResolversComposition;
    // tslint:disable-next-line:forin
    for (const path in resolversComposition) {
      const compositionArr = asArray(resolversComposition[path]);
      resolversComposition[path] = [
        (next: any) => async (root: any, args: any, appContext: any, info: any) => {
          const session = info.session || appContext.session;
          info.session = session;
          this.checkIfResolverCalledSafely(path, session, info);
          let moduleContext;
          try {
            moduleContext = await this.context(session, true);
          } catch (e) {
            console.error(e);
            throw e;
          }
          info.schema = this.schema;
          return next(root, args, moduleContext, info);
        },
        ...compositionArr,
      ];
    }
    return resolversComposition;
  }
  get selfLogger(): ILogger {
    let logger: ILogger;
    const loggerDefinitions = this._options.logger;
    if (loggerDefinitions) {
      if (logger instanceof Function) {
        logger = this.injector.call(loggerDefinitions as () => ILogger, this);
      } else {
        logger = loggerDefinitions as ILogger;
      }
    }
    return logger;
  }

  get selfResolverValidationOptions(): IResolverValidationOptions {
    let resolverValidationOptions: IResolverValidationOptions = {};
    const resolverValidationOptionsDefinitions = this._options.resolverValidationOptions;
    if (resolverValidationOptionsDefinitions) {
      if (resolverValidationOptionsDefinitions instanceof Function) {
        resolverValidationOptions = this.injector.call(resolverValidationOptionsDefinitions as () => IResolverValidationOptions, this);
      } else {
        resolverValidationOptions = resolverValidationOptionsDefinitions as IResolverValidationOptions;
      }
    }
    return resolverValidationOptions;
  }

  private static sessionModuleNameContextMap = new WeakMap<any, Map<string, any>>();

  getModuleNameContextMap(session: Session) {
    if (!GraphQLModule.sessionModuleNameContextMap.has(session)) {
      GraphQLModule.sessionModuleNameContextMap.set(session, new Map());
    }
    return GraphQLModule.sessionModuleNameContextMap.get(session);
  }

  /**
   * Build a GraphQL `context` object based on a network session.
   * It iterates over all modules by their dependency-based order, and executes
   * `contextBuilder` method.
   * It also in charge of injecting a reference to the application `Injector` to
   * the `context`.
   * The network session is passed to each `contextBuilder` method, and the return
   * value of each `contextBuilder` is merged into a unified `context` object.
   *
   * This method should be in use with your GraphQL manager, such as Apollo-Server.
   *
   * @param session - the network session from `connect`, `express`, etc...
   */
  get context(): (session: Session, excludeSession?: boolean) => Promise<ModuleContext<Context>> {
    if (!this._cache.contextBuilder) {
      this.checkConfiguration();
      const modulesMap = this.modulesMap;
      const contextBuilderSet = new Set<(session: Session, excludeSession?: boolean) => Promise<ModuleContext<Context>>>();
      this.iterateOverImports(module => {
        module.fixCacheForModulesMap(modulesMap, 'contextBuilder');
        const moduleContextBuilder = module.context;
        contextBuilderSet.add(moduleContextBuilder);
      });

      this._cache.contextBuilder = async (session, excludeSession = false) => {
        try {
          session = 'connection' in session ? session['connection']['context']['session'] : session;
          const moduleNameContextMap = this.getModuleNameContextMap(session);
          if (!(moduleNameContextMap.has(this.name))) {
            const importsContextArr$ = [...contextBuilderSet].map(contextBuilder => contextBuilder(session, true));
            const importsContextArr = await Promise.all(importsContextArr$);
            const importsContext = importsContextArr.reduce((acc, curr) => ({ ...acc, ...curr }), {} as any);
            const applicationInjector = this.injector;
            const sessionInjector = applicationInjector.getSessionInjector(session);
            const moduleSessionInfo = sessionInjector.has(ModuleSessionInfo) ? sessionInjector.get(ModuleSessionInfo) : new ModuleSessionInfo<Config, any, Context>(this, session);
            let moduleContext = {};
            const moduleContextDeclaration = this._options.context;
            if (moduleContextDeclaration) {
              if (moduleContextDeclaration instanceof Function) {
                moduleContext = await moduleContextDeclaration(session, { ...importsContext, sessionInjector }, moduleSessionInfo);
              } else {
                moduleContext = await moduleContextDeclaration;
              }
            }
            moduleNameContextMap.set(this.name, {
              ...importsContext,
              ...moduleContext,
              injector: sessionInjector,
            });
            const sessionHooks$ = [
              ...applicationInjector.scopeSet,
              ...sessionInjector.scopeSet,
            ].map(serviceIdentifier => moduleSessionInfo.callSessionHook(serviceIdentifier),
            );
            await Promise.all(sessionHooks$);
          }
          const moduleContext = moduleNameContextMap.get(this.name);
          if (excludeSession) {
            return moduleContext;
          } else {
            return {
              ...moduleContext,
              session,
            };
          }
        } catch (e) {
          if (e instanceof ContextBuilderError) {
            throw e;
          } else {
            throw new ContextBuilderError(this.name, e);
          }
        }
      };
    }
    return this._cache.contextBuilder;
  }

  get modulesMap() {
    if (!this._cache.modulesMap) {
      let modulesMap = this.createInitialModulesMap();
      modulesMap = this.checkAndFixModulesMap(modulesMap);
      this._cache.modulesMap = modulesMap;
    }
    return this._cache.modulesMap;
  }

  private createInitialModulesMap() {
    const modulesMap = new Map<string, GraphQLModule<any, Session, any>>();
    const visitModule = (module: GraphQLModule<any, Session, any>) => {
      if (!modulesMap.has(module.name)) {
        modulesMap.set(module.name, module);
        for (const subModule of module.selfImports) {
          if (!subModule) {
            throw new DependencyModuleUndefinedError(module.name);
          }
          if (typeof subModule !== 'string') {
            if (subModule._options.configRequired) {
              if (subModule.config) {
                visitModule(subModule);
              }
            } else {
              visitModule(subModule);
            }
          }
        }
      }
    };
    visitModule(this);
    return modulesMap;
  }

  private checkAndFixModulesMap(modulesMap: ModulesMap<Session>): Map<string, GraphQLModule<any, Session, any>> {
    const graph = new DepGraph<GraphQLModule<any, Session, any>>();

    modulesMap.forEach(module => {
      const moduleName = module.name;
      if (!graph.hasNode(moduleName)) {
        graph.addNode(moduleName);
      }
    });

    const visitedModulesToAddDependency = new Set<string>();

    const visitModuleToAddDependency = (module: GraphQLModule<any, Session, any>) => {
      for (let subModule of module.selfImports) {
        const subModuleOrigName = typeof subModule === 'string' ? subModule : subModule.name;
        subModule = modulesMap.get(subModuleOrigName);
        if (!subModule) {
          throw new DependencyModuleNotFoundError(subModuleOrigName, module.name);
        }
        try {
          graph.addDependency(
            module.name,
            subModule.name,
          );
        } catch (e) {
          throw new DependencyModuleNotFoundError(subModuleOrigName, module.name);
        }
        // prevent infinite loop in case of circular dependency
        if (!visitedModulesToAddDependency.has(subModule.name)) {
          visitedModulesToAddDependency.add(subModule.name);
          visitModuleToAddDependency(subModule);
        }
      }
    };

    visitModuleToAddDependency(modulesMap.get(this.name));

    try {
      graph.overallOrder();
      return modulesMap;
    } catch (e) {
      const { message } = e as Error;
      const currentPathStr = message.replace('Dependency Cycle Found: ', '');
      if (!this._options.mergeCircularImports) {
        throw e;
      }
      if (this._options.warnCircularImports) {
        this.selfLogger.log(e.message);
      }
      const currentPath = currentPathStr.split(' -> ');
      const moduleIndexMap = new Map<string, number>();
      let start = 0;
      let end = currentPath.length;
      currentPath.forEach((moduleName, index) => {
        if (moduleIndexMap.has(moduleName)) {
          start = moduleIndexMap.get(moduleName);
          end = index;
        } else {
          moduleIndexMap.set(moduleName, index);
        }
      });
      const realPath = currentPath.slice(start, end);
      const circularModules = Array.from(new Set(realPath)).map(moduleName => {
        // if it is merged module, get one module, it will be enough to get merged one.
        return modulesMap.get(moduleName);
      });
      const mergedModule = GraphQLModule.mergeModules<any, Session, any>(circularModules, this._options.warnCircularImports, modulesMap);
      for (const moduleName of realPath) {
        modulesMap.set(moduleName, mergedModule);
        for (const subModuleName of moduleName.split('+')) {
          if (modulesMap.has(subModuleName)) {
            modulesMap.set(subModuleName, mergedModule);
          }
        }
      }
      modulesMap.set(mergedModule.name, mergedModule);
      (mergedModule._options.imports as Array<ModuleDependency<any, any, any>>)
        = (mergedModule._options.imports as Array<ModuleDependency<any, any, any>>).filter(
          module => {
            const moduleName = typeof module === 'string' ? module : module.name;
            module = modulesMap.get(moduleName);
            return (module.name !== mergedModule.name);
          },
        );
      return this.checkAndFixModulesMap(modulesMap);
    }
  }

  static mergeModules<Config = any, Session = any, Context = any>(
    modules: Array<GraphQLModule<any, any, any>>,
    warnCircularImports = false,
    modulesMap?: ModulesMap<Session>): GraphQLModule<Config, Session, Context> {
    const nameSet = new Set();
    const typeDefsSet = new Set();
    const resolversSet = new Set<IResolvers<any, any>>();
    const contextBuilderSet = new Set<BuildContextFn<any, Session, any>>();
    const importsSet = new Set<ModuleDependency<any, any, any>>();
    const providersSet = new Set<Provider<any>>();
    const resolversCompositionSet = new Set<IResolversComposerMapping>();
    const schemaDirectivesSet = new Set<ISchemaDirectives>();
    const directiveResolversSet = new Set<IDirectiveResolvers>();
    const loggerSet = new Set<ILogger>();
    const extraSchemasSet = new Set<GraphQLSchema>();
    const middlewareSet = new Set<GraphQLModuleMiddleware<Session, any>>();
    for (const module of modules) {
      const subMergedModuleNames = module.name.split('+');
      for (const subMergedModuleName of subMergedModuleNames) {
        nameSet.add(subMergedModuleName);
      }
      const typeDefs = module.selfTypeDefs;
      if (typeDefs) {
        typeDefsSet.add(typeDefs);
      }
      resolversSet.add(module.selfResolvers);
      contextBuilderSet.add(module._options.context);
      for (let importModule of module.selfImports) {
        if (modulesMap) {
          importModule = modulesMap.get(typeof importModule === 'string' ? importModule : importModule.name);
        }
        importsSet.add(importModule);
      }
      for (const provider of module.selfProviders) {
        providersSet.add(provider);
      }
      resolversCompositionSet.add(module.selfResolversComposition);
      schemaDirectivesSet.add(module.selfSchemaDirectives);
      directiveResolversSet.add(module.selfDirectiveResolvers);
      for (const extraSchema of module.selfExtraSchemas) {
        extraSchemasSet.add(extraSchema);
      }
      loggerSet.add(module.selfLogger);
    }

    const name = [...nameSet].join('+');
    const typeDefs = [...typeDefsSet];
    const resolvers = mergeResolvers([...resolversSet]);
    const context = [...contextBuilderSet].reduce(
      (accContextBuilder, currentContextBuilder) => {
        return async (session, currentContext, injector) => {
          const accContext = await accContextBuilder(session, currentContext, injector);
          const moduleContext = typeof currentContextBuilder === 'function' ? await currentContextBuilder(session, currentContext, injector) : (currentContextBuilder || {});
          return {
            ...accContext,
            ...moduleContext,
          };
        };
      },
      () => ({}),
    );
    const imports = [...importsSet];
    const providers = [...providersSet];
    const resolversComposition = deepmerge.all([...resolversCompositionSet]);
    const schemaDirectives = deepmerge.all([...schemaDirectivesSet]) as ISchemaDirectives;
    const directiveResolvers = deepmerge.all([...directiveResolversSet]) as IDirectiveResolvers;
    const logger = {
      log(message: string) {
        for (const logger of loggerSet) {
          logger.log(message);
        }
      },
    };
    const extraSchemas = [...extraSchemasSet];
    const middleware = (moduleCache: ModuleCache<Session, any>) => {
      let result = {};
      for (const subMiddleware of middlewareSet) {
        result = Object.assign(result, subMiddleware(moduleCache));
      }
      return result;
    };
    return new GraphQLModule<Config, Session, Context>({
      name,
      typeDefs,
      resolvers,
      context,
      imports,
      providers,
      resolversComposition,
      schemaDirectives,
      directiveResolvers,
      logger,
      extraSchemas,
      middleware,
      warnCircularImports,
      mergeCircularImports: true,
    });
  }
}
