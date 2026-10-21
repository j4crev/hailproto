import type {SQL} from "bun";
import type {AppConfig} from "../config.js";
import type {KeyEncryptor} from "../identity/key-encryption.js";
import type {OnboardingRepository} from "../onboarding/repository.js";
import type {AddressVerificationService} from "../onboarding/activation.js";
import type {PlcDirectoryClient} from "../plc/client.js";
import {VerifiedPublicPlcResolver} from "../plc/public-resolver.js";
import {assertPublicPlcReaders,createIndependentPlcObserver,type IndependentPlcObserver} from "../plc/observers.js";
import type {SafeHttpsTransport} from "../discovery/safe-fetch.js";
import {PreparedMigrationTarget} from "./target-keys.js";
import {PortableCutoverGate} from "./cutover-gate.js";
import {ManagedTransferAuthorization} from "./managed-authorization.js";
import {ManagedTransferDelivery} from "./managed-delivery.js";
import {ManagedTransferFencePublisher} from "./managed-fence-publisher.js";
import {ManagedMigrationFenceService} from "./managed-fence.js";
import {ManagedMigrationExportService} from "./managed-snapshot.js";
import {ManagedMigrationStageService} from "./managed-stage.js";
import {ManagedMigrationPlcSubmission} from "./managed-plc-submission.js";
import {ManagedMigrationActivation} from "./managed-activation.js";
import {ManagedMigrationCompletion} from "./managed-completion.js";

export function createPublicManagedRuntime(config:AppConfig,sql:SQL,plc:PlcDirectoryClient,
  repository:OnboardingRepository,encryptor:KeyEncryptor,transport:Pick<SafeHttpsTransport,"fetch"|"validateTarget">,
  verifier:AddressVerificationService,readers?:readonly IndependentPlcObserver[]) {
  if(!config.publicManagedTransfer)return undefined;
  if(config.nodeEnv!=="production"||config.plcDirectoryUrl!=="https://plc.directory"||
    config.publicPlcAuthority?.profile!=="strict-public-v1"||config.pocManagedTransfer||
    config.publicPlcAuthority.providerOperators.length!==2)throw new Error("Public managed runtime requires production strict public authority without the private gate");
  const policy=config.publicPlcAuthority;
  const observers=readers??policy.readers.map(reader=>createIndependentPlcObserver(reader.origin,reader.operator));
  assertPublicPlcReaders(observers,policy.providerOperators,[config.publicOrigin]);
  if(observers.some((observer,index)=>observer.origin!==policy.readers[index]!.origin||observer.operator!==policy.readers[index]!.operator))
    throw new Error("Injected public readers must match reviewed declarations");
  const resolver=new VerifiedPublicPlcResolver(sql,observers,policy.providerOperators,[config.publicOrigin]);
  const targetKeys=new PreparedMigrationTarget(sql,encryptor,config.hailServiceBase,true);
  const gate=new PortableCutoverGate(sql,observers,undefined,policy.providerOperators,config.publicManagedTransfer,plc);
  const activation=new ManagedMigrationActivation(sql,encryptor,resolver,verifier,config.hailServiceBase,
    config.plcDirectoryUrl,"strict-public-v1",undefined,gate);
  return {resolver,targetKeys,activation,gate,
    authorization:new ManagedTransferAuthorization(sql,resolver,config.hailServiceBase,repository,encryptor),
    delivery:new ManagedTransferDelivery(sql,resolver,config.hailServiceBase,transport.fetch,transport.validateTarget),
    fencePublisher:new ManagedTransferFencePublisher(sql,resolver,targetKeys,transport.fetch,transport.validateTarget),
    fence:new ManagedMigrationFenceService(sql,resolver,config.hailServiceBase),
    exporter:new ManagedMigrationExportService(sql,repository,encryptor,resolver,config.hailServiceBase),
    completion:new ManagedMigrationCompletion(new ManagedMigrationStageService(sql,resolver,targetKeys,config.hailServiceBase),
      new ManagedMigrationPlcSubmission(sql,plc,resolver,config.hailServiceBase),activation,true)};
}
