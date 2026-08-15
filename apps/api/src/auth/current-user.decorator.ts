import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { User } from '../users/user.entity';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User => {
    return ctx.switchToHttp().getRequest().user as User;
  },
);

export const Auth0Sub = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    return (ctx.switchToHttp().getRequest().user as User).auth0Id;
  },
);
