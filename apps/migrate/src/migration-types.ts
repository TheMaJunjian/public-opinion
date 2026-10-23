import type {Change,Membership} from '@gonglun/core';
/** Previous-release audit metadata is consumed only by migration and verification tools. */
export type MigrationChange=Change&{upgrade?:{kind:'retire-legacy-topics';version:1;topicIds:string[];releasedMemberships:Membership[];retiredJoinIds:string[]}};
