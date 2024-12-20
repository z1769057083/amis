import difference from 'lodash/difference';
import omit from 'lodash/omit';
import React from 'react';
import {isValidElementType} from 'react-is';
import LazyComponent from './components/LazyComponent';
import {
  filterSchema,
  loadRendererError,
  loadAsyncRenderer,
  registerRenderer,
  RendererConfig,
  RendererEnv,
  RendererProps,
  resolveRenderer
} from './factory';
import {asFormItem} from './renderers/Item';
import {IScopedContext, ScopedContext} from './Scoped';
import {Schema, SchemaNode} from './types';
import {DebugWrapper} from './utils/debug';
import getExprProperties from './utils/filter-schema';
import {
  anyChanged,
  chainEvents,
  autobind,
  TestIdBuilder,
  formateId
} from './utils/helper';
import {SimpleMap} from './utils/SimpleMap';
import {
  bindEvent,
  bindGlobalEventForRenderer as bindGlobalEvent,
  dispatchEvent,
  RendererEvent
} from './utils/renderer-event';
import {isAlive} from 'mobx-state-tree';
import {reaction} from 'mobx';
import {resolveVariableAndFilter} from './utils/tpl-builtin';
import {buildStyle} from './utils/style';
import {isExpression} from './utils/formula';
import {StatusScopedProps} from './StatusScoped';
import {evalExpression, filter} from './utils/tpl';
import {CSSTransition} from 'react-transition-group';
import {createAnimationStyle} from './utils/animations';
import styleManager from './StyleManager';

interface SchemaRendererProps
  extends Partial<Omit<RendererProps, 'statusStore'>>,
    StatusScopedProps {
  schema: Schema;
  $path: string;
  env: RendererEnv;
}

export const RENDERER_TRANSMISSION_OMIT_PROPS = [
  'type',
  'name',
  '$ref',
  'className',
  'style',
  'data',
  'originData',
  'children',
  'ref',
  'visible',
  'loading',
  'visibleOn',
  'hidden',
  'hiddenOn',
  'disabled',
  'disabledOn',
  'static',
  'staticOn',
  'component',
  'detectField',
  'defaultValue',
  'defaultData',
  'required',
  'requiredOn',
  'syncSuperStore',
  'mode',
  'body',
  'id',
  'inputOnly',
  'label',
  'renderLabel',
  'trackExpression',
  'editorSetting',
  'updatePristineAfterStoreDataReInit',
  'source'
];

const componentCache: SimpleMap = new SimpleMap();

export class SchemaRenderer extends React.Component<SchemaRendererProps, any> {
  static displayName: string = 'Renderer';
  static contextType = ScopedContext;

  rendererKey = '';
  renderer: RendererConfig | null;
  ref: any;
  cRef: any;

  schema: any;
  path: string;

  animationTimeout: {
    enter?: number;
    exit?: number;
  } = {};
  animationClassNames: {
    appear?: string;
    enter?: string;
    exit?: string;
  } = {};

  toDispose: Array<() => any> = [];
  unbindEvent: (() => void) | undefined = undefined;
  unbindGlobalEvent: (() => void) | undefined = undefined;
  isStatic: any = undefined;

  constructor(props: SchemaRendererProps) {
    super(props);
    const animations = props?.schema?.animations;
    if (animations) {
      let id = props?.schema.id;
      id = formateId(id);
      if (animations.enter) {
        this.animationTimeout.enter =
          ((animations.enter.duration || 1) + (animations.enter.delay || 0)) *
          1000;
        this.animationClassNames.enter = `${animations.enter.type}-${id}-enter`;
        this.animationClassNames.appear = this.animationClassNames.enter;
      }
      if (animations.exit) {
        this.animationTimeout.exit =
          ((animations.exit.duration || 1) + (animations.exit.delay || 0)) *
          1000;
        this.animationClassNames.exit = `${animations.exit.type}-${id}-exit`;
      }
    }

    this.refFn = this.refFn.bind(this);
    this.renderChild = this.renderChild.bind(this);
    this.reRender = this.reRender.bind(this);
    this.resolveRenderer(this.props);
    this.dispatchEvent = this.dispatchEvent.bind(this);
    this.addAnimationAttention = this.addAnimationAttention.bind(this);
    this.removeAnimationAttention = this.removeAnimationAttention.bind(this);

    // 监听statusStore更新
    this.toDispose.push(
      reaction(
        () => {
          const id = filter(props.schema.id, props.data);
          const name = filter(props.schema.name, props.data);
          return `${
            props.statusStore.visibleState[id] ??
            props.statusStore.visibleState[name]
          }${
            props.statusStore.disableState[id] ??
            props.statusStore.disableState[name]
          }${
            props.statusStore.staticState[id] ??
            props.statusStore.staticState[name]
          }`;
        },
        () => this.forceUpdate()
      )
    );
  }

  componentDidMount(): void {
    if (this.props.schema.animations) {
      let {animations, id} = this.props.schema;
      id = formateId(id);
      createAnimationStyle(id, animations);
    }
  }

  componentWillUnmount() {
    this.toDispose.forEach(fn => fn());
    this.toDispose = [];
    this.unbindEvent?.();
    this.unbindGlobalEvent?.();
    this.removeAnimationStyle();
  }

  // 限制：只有 schema 除外的 props 变化，或者 schema 里面的某个成员值发生变化才更新。
  shouldComponentUpdate(nextProps: SchemaRendererProps) {
    const props = this.props;
    const list: Array<string> = difference(Object.keys(nextProps), [
      'schema',
      'scope'
    ]);

    if (
      difference(Object.keys(props), ['schema', 'scope']).length !==
        list.length ||
      anyChanged(list, this.props, nextProps)
    ) {
      return true;
    } else {
      const list: Array<string> = Object.keys(nextProps.schema);

      if (
        Object.keys(props.schema).length !== list.length ||
        anyChanged(list, props.schema, nextProps.schema)
      ) {
        return true;
      }
    }

    return false;
  }

  removeAnimationStyle() {
    if (this.props.schema.animations) {
      let {id} = this.props.schema;
      id = formateId(id);
      styleManager.removeStyles(id);
    }
  }

  resolveRenderer(props: SchemaRendererProps, force = false): any {
    let schema = props.schema;
    let path = props.$path;

    if (schema && schema.$ref) {
      schema = {
        ...props.resolveDefinitions(schema.$ref),
        ...schema
      };

      path = path.replace(/(?!.*\/).*/, schema.type);
    }

    if (
      schema?.type &&
      (force ||
        !this.renderer ||
        this.rendererKey !== `${schema.type}-${schema.$$id}`)
    ) {
      const rendererResolver = props.env.rendererResolver || resolveRenderer;
      this.renderer = rendererResolver(path, schema, props);
      this.rendererKey = `${schema.type}-${schema.$$id}`;
    } else {
      // 自定义组件如果在节点设置了 label name 什么的，就用 formItem 包一层
      // 至少自动支持了 valdiations, label, description 等逻辑。
      if (schema.children && !schema.component && schema.asFormItem) {
        schema.component = PlaceholderComponent;
        schema.renderChildren = schema.children;
        delete schema.children;
      }

      if (
        schema.component &&
        !schema.component.wrapedAsFormItem &&
        schema.asFormItem
      ) {
        const cache = componentCache.get(schema.component);

        if (cache) {
          schema.component = cache;
        } else {
          const cache = asFormItem({
            strictMode: false,
            ...schema.asFormItem
          })(schema.component);
          componentCache.set(schema.component, cache);
          cache.wrapedAsFormItem = true;
          schema.component = cache;
        }
      }
    }

    return {path, schema};
  }

  getWrappedInstance() {
    return this.cRef;
  }

  refFn(ref: any) {
    this.ref = ref;
  }

  @autobind
  childRef(ref: any) {
    // todo 这里有个问题，就是注意以下的这段注释
    // > // 原来表单项的 visible: false 和 hidden: true 表单项的值和验证是有效的
    // > 而 visibleOn 和 hiddenOn 是无效的，
    // > 这个本来就是个bug，但是已经被广泛使用了
    // > 我只能继续实现这个bug了
    // 这样会让子组件去根据是 hidden 的情况去渲染个 null，这样会导致这里 ref 有值，但是 ref.getWrappedInstance() 为 null
    // 这样会和直接渲染的组件时有些区别，至少 cRef 的指向是不一样的
    while (ref?.getWrappedInstance?.()) {
      ref = ref.getWrappedInstance();
    }

    if (ref && !ref.props) {
      Object.defineProperty(ref, 'props', {
        get: () => this.props
      });
    }

    if (ref) {
      // 这里无法区分监听的是不是广播，所以又bind一下，主要是为了绑广播
      this.unbindEvent?.();
      this.unbindGlobalEvent?.();

      this.unbindEvent = bindEvent(ref);
      this.unbindGlobalEvent = bindGlobalEvent(ref);
    }
    this.cRef = ref;
  }

  async dispatchEvent(
    e: React.MouseEvent<any>,
    data: any,
    renderer?: React.Component<RendererProps> // for didmount
  ): Promise<RendererEvent<any> | void> {
    return await dispatchEvent(
      e,
      this.cRef || renderer,
      this.context as IScopedContext,
      data
    );
  }

  renderChild(
    region: string,
    node?: SchemaNode,
    subProps: {
      data?: object;
      [propName: string]: any;
    } = {}
  ) {
    let {schema: _, $path: __, env, render, ...rest} = this.props;
    let {path: $path} = this.resolveRenderer(this.props);

    const omitList = RENDERER_TRANSMISSION_OMIT_PROPS.concat();
    if (this.renderer) {
      const Component = this.renderer.component;
      Component?.propsList &&
        omitList.push.apply(omitList, Component.propsList as Array<string>);
    }

    return render!(`${$path}${region ? `/${region}` : ''}`, node || '', {
      ...omit(rest, omitList),
      defaultStatic:
        (this.renderer?.type &&
        ['drawer', 'dialog'].includes(this.renderer.type)
          ? false
          : undefined) ??
        this.isStatic ??
        (_.staticOn
          ? evalExpression(_.staticOn, rest.data)
          : _.static ?? rest.defaultStatic),
      ...subProps,
      data: subProps.data || rest.data,
      env: env
    });
  }

  reRender() {
    this.resolveRenderer(this.props, true);
    this.forceUpdate();
  }

  addAnimationAttention(node: HTMLElement) {
    const {schema} = this.props || {};
    const {attention} = schema?.animations || {};
    if (attention) {
      let {id} = schema;
      id = formateId(id);
      node.classList.add(`${attention.type}-${id}-attention`);
    }
  }
  removeAnimationAttention(node: HTMLElement) {
    const {schema} = this.props || {};
    const {attention} = schema?.animations || {};
    if (attention) {
      let {id} = schema;
      id = formateId(id);
      node.classList.remove(`${attention.type}-${id}-attention`);
    }
  }

  render(): JSX.Element | null {
    let {
      $path: _,
      schema: __,
      rootStore,
      statusStore,
      render,
      key: propKey,
      ...rest
    } = this.props;

    if (__ == null) {
      return null;
    }

    let {path: $path, schema} = this.resolveRenderer(this.props);
    const theme = this.props.env.theme;

    if (Array.isArray(schema)) {
      return render!($path, schema as any, rest) as JSX.Element;
    }

    const detectData =
      schema &&
      (schema.detectField === '&' ? rest : rest[schema.detectField || 'data']);
    let exprProps: any = detectData
      ? getExprProperties(schema, detectData, undefined, rest)
      : {};

    // 控制显隐
    const id = filter(schema.id, rest.data);
    const name = filter(schema.name, rest.data);
    const visible = isAlive(statusStore)
      ? statusStore.visibleState[id] ?? statusStore.visibleState[name]
      : undefined;
    const disable = isAlive(statusStore)
      ? statusStore.disableState[id] ?? statusStore.disableState[name]
      : undefined;
    const isStatic = isAlive(statusStore)
      ? statusStore.staticState[id] ?? statusStore.staticState[name]
      : undefined;
    this.isStatic = isStatic;

    if (
      visible === false ||
      (visible !== true &&
        exprProps &&
        (exprProps.hidden ||
          exprProps.visible === false ||
          schema.hidden ||
          schema.visible === false ||
          rest.hidden ||
          rest.visible === false))
    ) {
      (rest as any).invisible = true;
    }

    if (schema.children) {
      return rest.invisible
        ? null
        : React.isValidElement(schema.children)
        ? schema.children
        : typeof schema.children !== 'function'
        ? null
        : (schema.children as Function)({
            ...rest,
            ...exprProps,
            $path: $path,
            $schema: schema,
            render: this.renderChild,
            forwardedRef: this.refFn,
            rootStore,
            statusStore,
            dispatchEvent: this.dispatchEvent
          });
    } else if (schema.component && isValidElementType(schema.component)) {
      const isSFC = !(schema.component.prototype instanceof React.Component);
      const {
        data: defaultData,
        value: defaultValue, // render时的value改放defaultValue中
        activeKey: defaultActiveKey,
        ...restSchema
      } = schema;
      return rest.invisible
        ? null
        : React.createElement(schema.component as any, {
            ...rest,
            ...restSchema,
            ...exprProps,
            // value: defaultValue, // 备注: 此处并没有将value传递给渲染器
            defaultData,
            defaultValue,
            defaultActiveKey,
            propKey,
            $path: $path,
            $schema: schema,
            ref: isSFC ? undefined : this.refFn,
            forwardedRef: isSFC ? this.refFn : undefined,
            render: this.renderChild,
            rootStore,
            statusStore,
            dispatchEvent: this.dispatchEvent
          });
    } else if (Object.keys(schema).length === 0) {
      return null;
    } else if (!this.renderer) {
      return rest.invisible ? null : (
        <LazyComponent
          defaultVisible={true}
          getComponent={async () => {
            const result = await rest.env.loadRenderer(
              schema,
              $path,
              this.reRender
            );
            if (result && typeof result === 'function') {
              return result;
            } else if (result && React.isValidElement(result)) {
              return () => result;
            }

            this.reRender();
            return () => loadRendererError(schema, $path);
          }}
        />
      );
    } else if (this.renderer.getComponent && !this.renderer.component) {
      // 处理异步渲染器
      return rest.invisible ? null : (
        <LazyComponent
          defaultVisible={true}
          getComponent={async () => {
            await loadAsyncRenderer(this.renderer as RendererConfig);
            this.reRender();
            return () => null;
          }}
        />
      );
    }

    const renderer = this.renderer as RendererConfig;
    schema = filterSchema(schema, renderer, rest);
    const {
      data: defaultData,
      value: defaultValue,
      activeKey: defaultActiveKey,
      ...restSchema
    } = schema;
    const Component = renderer.component!;

    let animationIn = true;

    // 原来表单项的 visible: false 和 hidden: true 表单项的值和验证是有效的
    // 而 visibleOn 和 hiddenOn 是无效的，
    // 这个本来就是个bug，但是已经被广泛使用了
    // 我只能继续实现这个bug了
    if (
      rest.invisible &&
      (exprProps.hidden ||
        exprProps.visible === false ||
        !renderer.isFormItem ||
        (schema.visible !== false && !schema.hidden))
    ) {
      if (schema.animations) {
        animationIn = false;
      } else {
        return null;
      }
    }

    // withStore 里面会处理，而且会实时处理
    // 这里处理反而导致了问题
    if (renderer.storeType) {
      exprProps = {};
    }

    const supportRef =
      Component.prototype?.isReactComponent ||
      (Component as any).$$typeof === Symbol.for('react.forward_ref');
    let props: any = {
      ...renderer.defaultProps?.(schema.type, schema),
      ...theme.getRendererConfig(renderer.name),
      ...restSchema,
      ...chainEvents(rest, restSchema),
      ...exprProps,
      // value: defaultValue, // 备注: 此处并没有将value传递给渲染器
      defaultData: restSchema.defaultData ?? defaultData,
      defaultValue: restSchema.defaultValue ?? defaultValue,
      defaultActiveKey: defaultActiveKey,
      propKey: propKey,
      $path: $path,
      $schema: schema,
      render: this.renderChild,
      rootStore,
      statusStore,
      dispatchEvent: this.dispatchEvent,
      mobileUI: schema.useMobileUI === false ? false : rest.mobileUI
    };

    // style 支持公式
    if (schema.style) {
      (props as any).style = buildStyle(schema.style, detectData);
    }

    if (disable !== undefined) {
      (props as any).disabled = disable;
    }

    if (isStatic !== undefined) {
      (props as any).static = isStatic;
    }

    // 优先使用组件自己的testid或者id，这个解决不了table行内的一些子元素
    // 每一行都会出现这个testid的元素，只在测试工具中直接使用nth拿序号
    if (rest.env.enableTestid) {
      if (props.testid || props.id || props.testIdBuilder == null) {
        if (!(props.testIdBuilder instanceof TestIdBuilder)) {
          props.testIdBuilder = new TestIdBuilder(props.testid || props.id);
        }
      }
    }

    // 自动解析变量模式，主要是方便直接引入第三方组件库，无需为了支持变量封装一层
    if (renderer.autoVar) {
      for (const key of Object.keys(schema)) {
        if (typeof props[key] === 'string' && isExpression(props[key])) {
          props[key] = resolveVariableAndFilter(
            props[key],
            props.data,
            '| raw'
          );
        }
      }
    }

    let component = supportRef ? (
      <Component {...props} ref={this.childRef} />
    ) : (
      <Component {...props} forwardedRef={this.childRef} />
    );

    if (schema.animations) {
      component = (
        <CSSTransition
          in={animationIn}
          timeout={this.animationTimeout}
          classNames={this.animationClassNames}
          onEntered={this.addAnimationAttention}
          onExit={this.removeAnimationAttention}
          appear
          unmountOnExit
        >
          {component}
        </CSSTransition>
      );
    }

    return this.props.env.enableAMISDebug ? (
      <DebugWrapper renderer={renderer}>{component}</DebugWrapper>
    ) : (
      component
    );
  }
}

class PlaceholderComponent extends React.Component {
  childRef = React.createRef<any>();

  getWrappedInstance() {
    return this.childRef.current;
  }

  render() {
    const {renderChildren, ...rest} = this.props as any;

    if (typeof renderChildren === 'function') {
      return renderChildren({
        ...rest,
        ref: this.childRef
      });
    }

    return null;
  }
}
