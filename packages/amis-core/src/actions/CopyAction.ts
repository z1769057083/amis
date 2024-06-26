import {RendererEvent} from '../utils/renderer-event';
import {
  RendererAction,
  ListenerAction,
  ListenerContext,
  registerAction
} from './Action';

export interface ICopyAction extends ListenerAction {
  actionType: 'copy';
  args: {
    content: string;
    copyFormat?: string;
    [propName: string]: any;
  };
}

/**
 * 复制动作
 *
 * @export
 * @class CopyAction
 * @implements {Action}
 */
export class CopyAction implements RendererAction {
  async run(
    action: ICopyAction,
    renderer: ListenerContext,
    event: RendererEvent<any>
  ) {
    if (!event.context.env?.copy) {
      throw new Error('env.copy is required!');
    }

    if (action.args?.content) {
      event.context.env?.copy?.(action.args.content, {
        format: action.args?.copyFormat
      });
    }
  }
}

registerAction('copy', new CopyAction());
