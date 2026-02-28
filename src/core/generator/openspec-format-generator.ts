/**
 * OpenSpec Format Generator
 *
 * Takes structured LLM outputs and formats them into clean OpenSpec-compatible
 * specification files.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PipelineResult,
  ProjectSurveyResult,
  ExtractedEntity,
  ExtractedService,
  ExtractedEndpoint,
  ArchitectureSynthesis,
  Scenario,
} from './spec-pipeline.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Generated spec file
 */
export interface GeneratedSpec {
  path: string;
  content: string;
  domain: string;
  type: 'overview' | 'domain' | 'architecture' | 'api';
}

/**
 * Generator options
 */
export interface GeneratorOptions {
  /** Version string for headers */
  version?: string;
  /** Output style */
  style?: 'minimal' | 'detailed';
  /** Include confidence indicators */
  includeConfidence?: boolean;
  /** Include technical notes */
  includeTechnicalNotes?: boolean;
  /** Maximum line width for wrapping */
  maxLineWidth?: number;
}

/**
 * Domain grouping for spec generation
 */
interface DomainGroup {
  name: string;
  description: string;
  entities: ExtractedEntity[];
  services: ExtractedService[];
  endpoints: ExtractedEndpoint[];
  files: string[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_OPTIONS: Required<GeneratorOptions> = {
  version: '1.0.0',
  style: 'detailed',
  includeConfidence: true,
  includeTechnicalNotes: true,
  maxLineWidth: 100,
};

// ============================================================================
// OPENSPEC FORMAT GENERATOR
// ============================================================================

/**
 * OpenSpec Format Generator
 */
export class OpenSpecFormatGenerator {
  private options: Required<GeneratorOptions>;

  constructor(options: GeneratorOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Generate all spec files from pipeline result
   */
  generateSpecs(result: PipelineResult): GeneratedSpec[] {
    const specs: GeneratedSpec[] = [];
    const domains = this.groupByDomain(result);

    // 1. Overview spec
    specs.push(this.generateOverviewSpec(result.survey, domains, result.architecture));

    // 2. Domain specs
    for (const domain of domains) {
      specs.push(this.generateDomainSpec(domain, result.survey));
    }

    // 3. Architecture spec
    specs.push(this.generateArchitectureSpec(result.architecture, result.survey, domains));

    // 4. API spec (if endpoints exist)
    if (result.endpoints.length > 0) {
      specs.push(this.generateApiSpec(result.endpoints, result.survey));
    }

    return specs;
  }

  /**
   * Group entities, services, and endpoints by domain
   */
  private groupByDomain(result: PipelineResult): DomainGroup[] {
    const domainMap = new Map<string, DomainGroup>();

    // Initialize domains from survey suggestions
    for (const domainName of result.survey.suggestedDomains) {
      domainMap.set(domainName.toLowerCase(), {
        name: domainName,
        description: '',
        entities: [],
        services: [],
        endpoints: [],
        files: [],
      });
    }

    // Add entities to domains
    for (const entity of result.entities) {
      const domainName = this.inferDomain(entity.name, entity.location, result.survey.suggestedDomains);
      let domain = domainMap.get(domainName.toLowerCase());
      if (!domain) {
        domain = {
          name: domainName,
          description: '',
          entities: [],
          services: [],
          endpoints: [],
          files: [],
        };
        domainMap.set(domainName.toLowerCase(), domain);
      }
      domain.entities.push(entity);
      if (entity.location && !domain.files.includes(entity.location)) {
        domain.files.push(entity.location);
      }
    }

    // Add services to domains
    for (const service of result.services) {
      const domainName = service.domain || this.inferDomain(service.name, '', result.survey.suggestedDomains);
      let domain = domainMap.get(domainName.toLowerCase());
      if (!domain) {
        domain = {
          name: domainName,
          description: '',
          entities: [],
          services: [],
          endpoints: [],
          files: [],
        };
        domainMap.set(domainName.toLowerCase(), domain);
      }
      domain.services.push(service);
    }

    // Add endpoints to domains
    for (const endpoint of result.endpoints) {
      const domainName = endpoint.relatedEntity
        ? this.inferDomain(endpoint.relatedEntity, endpoint.path, result.survey.suggestedDomains)
        : 'api';
      let domain = domainMap.get(domainName.toLowerCase());
      if (!domain) {
        domain = {
          name: domainName,
          description: '',
          entities: [],
          services: [],
          endpoints: [],
          files: [],
        };
        domainMap.set(domainName.toLowerCase(), domain);
      }
      domain.endpoints.push(endpoint);
    }

    // Set descriptions based on content
    for (const domain of domainMap.values()) {
      if (domain.entities.length > 0) {
        domain.description = `Manages ${domain.entities.map(e => e.name).join(', ')} entities`;
      } else if (domain.services.length > 0) {
        domain.description = domain.services[0].purpose;
      } else if (domain.endpoints.length > 0) {
        const firstPurpose = domain.endpoints[0]?.purpose;
        domain.description = firstPurpose
          ? firstPurpose
          : `Provides ${domain.endpoints.length} API endpoint${domain.endpoints.length > 1 ? 's' : ''}`;
      }
    }

    // Filter out empty domains
    return Array.from(domainMap.values()).filter(
      d => d.entities.length > 0 || d.services.length > 0 || d.endpoints.length > 0
    );
  }

  /**
   * Infer domain from name and location
   */
  private inferDomain(name: string, location: string, suggestedDomains: string[]): string {
    const nameLower = name.toLowerCase();
    const locationLower = location.toLowerCase();

    // Check suggested domains first
    for (const domain of suggestedDomains) {
      if (nameLower.includes(domain.toLowerCase()) || locationLower.includes(domain.toLowerCase())) {
        return domain;
      }
    }

    // Extract from name (e.g., UserService -> user)
    const match = name.match(/^([A-Z][a-z]+)/);
    if (match) {
      return match[1].toLowerCase();
    }

    return 'core';
  }

  /**
   * Generate the overview spec
   */
  private generateOverviewSpec(
    survey: ProjectSurveyResult,
    domains: DomainGroup[],
    architecture: ArchitectureSynthesis
  ): GeneratedSpec {
    const lines: string[] = [];
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Header
    lines.push('# System Overview');
    lines.push('');
    lines.push(`> Generated by spec-gen v${this.options.version} on ${date}`);
    if (this.options.includeConfidence) {
      lines.push(`> Confidence: ${Math.round(survey.confidence * 100)}%`);
    }
    lines.push('');

    // Purpose
    lines.push('## Purpose');
    lines.push('');
    lines.push(this.wrapText(architecture.systemPurpose));
    lines.push('');

    // Domains
    lines.push('## Domains');
    lines.push('');
    lines.push('This system is organized into the following domains:');
    lines.push('');
    lines.push('| Domain | Description | Spec |');
    lines.push('|--------|-------------|------|');
    for (const domain of domains) {
      const specPath = `../${domain.name.toLowerCase()}/spec.md`;
      lines.push(`| ${this.capitalize(domain.name)} | ${domain.description || 'No description'} | [spec.md](${specPath}) |`);
    }
    lines.push('');

    // Technical Stack
    lines.push('## Technical Stack');
    lines.push('');
    lines.push(`- **Type**: ${this.formatCategory(survey.projectCategory)}`);
    lines.push(`- **Primary Language**: ${survey.primaryLanguage}`);
    lines.push(`- **Key Frameworks**: ${survey.frameworks.join(', ') || 'None detected'}`);
    lines.push(`- **Architecture**: ${this.formatArchitecture(survey.architecturePattern)}`);
    lines.push('');

    // Requirements
    lines.push('## Requirements');
    lines.push('');

    // Generate capabilities from architecture
    if (architecture.keyDecisions.length > 0) {
      lines.push('### Requirement: SystemCapabilities');
      lines.push('');
      lines.push('The system SHALL provide the following capabilities:');
      for (const decision of architecture.keyDecisions) {
        lines.push(`- ${decision}`);
      }
      lines.push('');
      lines.push('#### Scenario: CapabilitiesProvided');
      lines.push('- **GIVEN** the system is operational');
      lines.push('- **WHEN** a user interacts with the system');
      lines.push('- **THEN** the system provides the documented capabilities');
      lines.push('');
    }

    // Data flow as a scenario
    if (architecture.dataFlow && architecture.dataFlow !== 'Unknown') {
      lines.push('### Requirement: DataFlow');
      lines.push('');
      lines.push('The system SHALL process data through defined layers:');
      lines.push('');
      lines.push('#### Scenario: StandardDataFlow');
      lines.push('- **GIVEN** an incoming request');
      lines.push(`- **WHEN** the request is processed`);
      lines.push(`- **THEN** data flows through: ${architecture.dataFlow}`);
      lines.push('');
    }

    // Technical notes
    if (this.options.includeTechnicalNotes) {
      lines.push('## Technical Notes');
      lines.push('');
      const archStyleNote = typeof architecture.architectureStyle === 'string'
        ? architecture.architectureStyle
        : (architecture.architectureStyle as any)?.pattern ?? (architecture.architectureStyle as any)?.name ?? JSON.stringify(architecture.architectureStyle);
      lines.push(`- **Architecture Style**: ${archStyleNote}`);
      if (architecture.securityModel && architecture.securityModel !== 'Unknown') {
        lines.push(`- **Security Model**: ${architecture.securityModel}`);
      }
      if (architecture.integrations.length > 0) {
        const integrationNames = architecture.integrations.map(i =>
          typeof i === 'string' ? i : (i as any).name ?? JSON.stringify(i)
        );
        lines.push(`- **External Integrations**: ${integrationNames.join(', ')}`);
      }
      lines.push('');
    }

    return {
      path: 'openspec/specs/overview/spec.md',
      content: lines.join('\n'),
      domain: 'overview',
      type: 'overview',
    };
  }

  /**
   * Generate a domain spec
   */
  private generateDomainSpec(domain: DomainGroup, survey: ProjectSurveyResult): GeneratedSpec {
    const lines: string[] = [];
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Header
    lines.push(`# ${this.capitalize(domain.name)} Specification`);
    lines.push('');
    lines.push(`> Generated by spec-gen v${this.options.version} on ${date}`);
    if (domain.files.length > 0) {
      lines.push(`> Source files: ${domain.files.join(', ')}`);
    }
    lines.push('');

    // Purpose
    lines.push('## Purpose');
    lines.push('');
    lines.push(this.wrapText(domain.description || `The ${domain.name} domain manages core business logic.`));
    lines.push('');

    // Entities section
    if (domain.entities.length > 0) {
      lines.push('## Entities');
      lines.push('');

      for (const entity of domain.entities) {
        lines.push(`### ${entity.name}`);
        lines.push('');
        lines.push(this.wrapText(entity.description));
        lines.push('');

        // Properties table
        if (entity.properties.length > 0) {
          lines.push('**Properties:**');
          lines.push('');
          lines.push('| Name | Type | Description |');
          lines.push('|------|------|-------------|');
          for (const prop of entity.properties) {
            const desc = prop.description || (prop.required ? 'Required' : 'Optional');
            lines.push(`| ${prop.name} | ${prop.type} | ${desc} |`);
          }
          lines.push('');
        }

        // Relationships
        if (entity.relationships.length > 0) {
          lines.push('**Relationships:**');
          lines.push('');
          for (const rel of entity.relationships) {
            lines.push(`- ${this.formatRelationship(rel)}`);
          }
          lines.push('');
        }
      }
    }

    // Requirements section
    lines.push('## Requirements');
    lines.push('');

    // Entity validation requirements
    for (const entity of domain.entities) {
      if (entity.validations.length > 0) {
        lines.push(`### Requirement: ${entity.name}Validation`);
        lines.push('');
        lines.push(`The system SHALL validate ${entity.name} according to these rules:`);
        for (const rule of entity.validations) {
          lines.push(`- ${rule}`);
        }
        lines.push('');

        // Scenarios from entity
        for (const scenario of entity.scenarios) {
          this.addScenario(lines, scenario);
        }
      }
    }

    // Service operation requirements
    for (const service of domain.services) {
      for (const operation of service.operations) {
        lines.push(`### Requirement: ${this.formatRequirementName(operation.name)}`);
        lines.push('');
        lines.push(`The system SHALL ${(operation.description ?? '').toLowerCase()}`);
        lines.push('');

        // Operation scenarios
        for (const scenario of operation.scenarios) {
          this.addScenario(lines, scenario);
        }
      }
    }

    // Fallback: if no requirements were generated, add a placeholder
    const hasRequirements =
      domain.entities.some(e => e.validations.length > 0) ||
      domain.services.some(s => s.operations.length > 0);
    if (!hasRequirements) {
      if (domain.endpoints.length > 0) {
        for (const endpoint of domain.endpoints) {
          const reqName = this.formatRequirementName(
            endpoint.purpose || `${endpoint.method}${endpoint.path}`
          );
          lines.push(`### Requirement: ${reqName}`);
          lines.push('');
          lines.push(`The system SHALL ${(endpoint.purpose ?? 'handle this endpoint').toLowerCase()}`);
          lines.push('');
          lines.push(`#### Scenario: ${reqName}Success`);
          lines.push(`- **GIVEN** the system is operational`);
          lines.push(`- **WHEN** ${endpoint.method} ${endpoint.path} is called`);
          lines.push(`- **THEN** the request is processed successfully`);
          lines.push('');
        }
      } else {
        const reqName = this.formatRequirementName(`${domain.name}Overview`);
        lines.push(`### Requirement: ${reqName}`);
        lines.push('');
        lines.push(`The ${domain.name} domain SHALL provide its documented functionality.`);
        lines.push('');
        lines.push(`#### Scenario: ${reqName}Works`);
        lines.push('- **GIVEN** the system is operational');
        lines.push('- **WHEN** the domain functionality is invoked');
        lines.push('- **THEN** the expected outcome is produced');
        lines.push('');
      }
    }

    // Technical notes
    if (this.options.includeTechnicalNotes && domain.services.length > 0) {
      lines.push('## Technical Notes');
      lines.push('');

      const allFiles = new Set<string>(domain.files);
      const allDeps = new Set<string>();

      for (const service of domain.services) {
        for (const dep of service.dependencies) {
          allDeps.add(dep);
        }
      }

      if (allFiles.size > 0) {
        lines.push(`- **Implementation**: \`${Array.from(allFiles).join(', ')}\``);
      }
      if (allDeps.size > 0) {
        lines.push(`- **Dependencies**: ${Array.from(allDeps).join(', ')}`);
      }
      lines.push('');
    }

    return {
      path: `openspec/specs/${domain.name.toLowerCase()}/spec.md`,
      content: lines.join('\n'),
      domain: domain.name.toLowerCase(),
      type: 'domain',
    };
  }

  /**
   * Generate the architecture spec
   */
  private generateArchitectureSpec(
    architecture: ArchitectureSynthesis,
    survey: ProjectSurveyResult,
    domains: DomainGroup[]
  ): GeneratedSpec {
    const lines: string[] = [];
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Header
    lines.push('# Architecture Specification');
    lines.push('');
    lines.push(`> Generated by spec-gen v${this.options.version} on ${date}`);
    lines.push('');

    // Purpose
    lines.push('## Purpose');
    lines.push('');
    lines.push('This document describes the architectural patterns and structure of the system.');
    lines.push('');

    // Architecture Style
    lines.push('## Architecture Style');
    lines.push('');
    const archStyle = architecture.architectureStyle;
    const archStyleStr = typeof archStyle === 'string'
      ? archStyle
      : (archStyle as any)?.pattern ?? (archStyle as any)?.name ?? JSON.stringify(archStyle);
    const archJustification = typeof archStyle === 'object' && archStyle !== null
      ? (archStyle as any)?.justification
      : undefined;
    lines.push(this.wrapText(archStyleStr));
    if (archJustification) {
      lines.push('');
      lines.push(`*${archJustification}*`);
    }
    lines.push('');

    // Requirements
    lines.push('## Requirements');
    lines.push('');

    // Layered architecture requirement
    if (architecture.layerMap.length > 0) {
      lines.push('### Requirement: LayeredArchitecture');
      lines.push('');
      lines.push('The system SHALL maintain separation between:');
      for (const layer of architecture.layerMap) {
        lines.push(`- ${layer.name} (${layer.purpose})`);
      }
      lines.push('');

      lines.push('#### Scenario: LayerSeparation');
      lines.push('- **GIVEN** a request from the presentation layer');
      lines.push('- **WHEN** business logic is needed');
      lines.push('- **THEN** the presentation layer delegates to the business layer');
      lines.push('- **AND** direct database access from presentation is prohibited');
      lines.push('');
    }

    // Security requirement
    if (architecture.securityModel && architecture.securityModel !== 'Unknown') {
      lines.push('### Requirement: SecurityModel');
      lines.push('');
      lines.push(`The system SHALL implement security via: ${architecture.securityModel}`);
      lines.push('');

      lines.push('#### Scenario: AuthenticatedAccess');
      lines.push('- **GIVEN** an unauthenticated request');
      lines.push('- **WHEN** accessing protected resources');
      lines.push('- **THEN** access is denied');
      lines.push('');
    }

    // System Diagram (Mermaid)
    lines.push('## System Diagram');
    lines.push('');
    lines.push('```mermaid');
    lines.push('graph TB');

    // Generate layer diagram
    for (let i = 0; i < architecture.layerMap.length; i++) {
      const layer = architecture.layerMap[i];
      const layerId = layer.name.replace(/\s+/g, '');
      lines.push(`    ${layerId}[${layer.name}]`);

      if (i < architecture.layerMap.length - 1) {
        const nextLayerId = architecture.layerMap[i + 1].name.replace(/\s+/g, '');
        lines.push(`    ${layerId} --> ${nextLayerId}`);
      }
    }

    lines.push('```');
    lines.push('');

    // Layer Structure
    lines.push('## Layer Structure');
    lines.push('');

    for (const layer of architecture.layerMap) {
      lines.push(`### ${layer.name}`);
      lines.push('');
      lines.push(`**Purpose**: ${layer.purpose}`);
      if (layer.components.length > 0) {
        lines.push(`**Location**: \`${layer.components.join(', ')}\``);
      }
      lines.push('');
    }

    // Data Flow
    lines.push('## Data Flow');
    lines.push('');
    if (architecture.dataFlow && architecture.dataFlow !== 'Unknown') {
      lines.push(this.wrapText(architecture.dataFlow));
    } else {
      lines.push('Data flows through the defined layers in sequence.');
    }
    lines.push('');

    // External Integrations
    if (architecture.integrations.length > 0) {
      lines.push('## External Integrations');
      lines.push('');
      lines.push('| System | Purpose |');
      lines.push('|--------|---------|');
      for (const integration of architecture.integrations) {
        const name = typeof integration === 'string' ? integration : (integration as any).name ?? String(integration);
        const purpose = typeof integration === 'object' && integration !== null
          ? ((integration as any).purpose ?? 'External integration')
          : 'External integration';
        lines.push(`| ${name} | ${purpose} |`);
      }
      lines.push('');
    }

    return {
      path: 'openspec/specs/architecture/spec.md',
      content: lines.join('\n'),
      domain: 'architecture',
      type: 'architecture',
    };
  }

  /**
   * Generate the API spec
   */
  private generateApiSpec(endpoints: ExtractedEndpoint[], survey: ProjectSurveyResult): GeneratedSpec {
    const lines: string[] = [];
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Header
    lines.push('# API Specification');
    lines.push('');
    lines.push(`> Generated by spec-gen v${this.options.version} on ${date}`);
    lines.push('');

    // Purpose
    lines.push('## Purpose');
    lines.push('');
    lines.push('This document specifies the HTTP API exposed by the system.');
    lines.push('');

    // Requirements section (always present)
    lines.push('## Requirements');
    lines.push('');

    // Authentication requirement
    const authMethods = new Set(endpoints.map(e => e.authentication).filter(Boolean));
    if (authMethods.size > 0) {
      lines.push('### Requirement: APIAuthentication');
      lines.push('');
      lines.push(`The API SHALL require authentication via: ${Array.from(authMethods).join(', ')}`);
      lines.push('');

      lines.push('#### Scenario: AuthenticatedRequest');
      lines.push('- **GIVEN** a request with valid authentication credentials');
      lines.push('- **WHEN** the request is processed');
      lines.push('- **THEN** the request is authenticated successfully');
      lines.push('');

      lines.push('#### Scenario: UnauthenticatedRequest');
      lines.push('- **GIVEN** a request without authentication');
      lines.push('- **WHEN** accessing a protected endpoint');
      lines.push('- **THEN** the response status is 401 Unauthorized');
      lines.push('');
    }

    // Group endpoints by related entity
    const endpointsByResource = new Map<string, ExtractedEndpoint[]>();
    for (const endpoint of endpoints) {
      const resource = endpoint.relatedEntity || 'General';
      const existing = endpointsByResource.get(resource) || [];
      existing.push(endpoint);
      endpointsByResource.set(resource, existing);
    }

    // Endpoint requirements (under ## Requirements, no separate ## Endpoints section)
    for (const [resource, resourceEndpoints] of endpointsByResource) {
      for (const endpoint of resourceEndpoints) {
        const reqName = this.formatRequirementName(`${endpoint.method}${resource}`);
        lines.push(`### Requirement: ${reqName}`);
        lines.push('');
        lines.push(`The API SHALL support \`${endpoint.method} ${endpoint.path}\` to ${(endpoint.purpose ?? '').toLowerCase()}`);
        lines.push('');

        // Request schema
        if (endpoint.requestSchema && Object.keys(endpoint.requestSchema).length > 0) {
          lines.push('**Request:**');
          lines.push('');
          lines.push('```json');
          lines.push(JSON.stringify(endpoint.requestSchema, null, 2));
          lines.push('```');
          lines.push('');
        }

        // Response schema
        if (endpoint.responseSchema && Object.keys(endpoint.responseSchema).length > 0) {
          lines.push('**Response:**');
          lines.push('');
          lines.push('```json');
          lines.push(JSON.stringify(endpoint.responseSchema, null, 2));
          lines.push('```');
          lines.push('');
        }

        // Scenarios
        for (const scenario of endpoint.scenarios) {
          this.addScenario(lines, scenario);
        }

        // Default success scenario if none provided
        if (endpoint.scenarios.length === 0) {
          lines.push(`#### Scenario: ${reqName}Success`);
          lines.push('- **GIVEN** an authenticated user');
          lines.push(`- **WHEN** \`${endpoint.method} ${endpoint.path}\` is called with valid data`);
          lines.push('- **THEN** the response status is 200 OK');
          lines.push('');
        }
      }
    }

    return {
      path: 'openspec/specs/api/spec.md',
      content: lines.join('\n'),
      domain: 'api',
      type: 'api',
    };
  }

  /**
   * Add a scenario to the lines array
   */
  private addScenario(lines: string[], scenario: Scenario): void {
    lines.push(`#### Scenario: ${this.formatRequirementName(scenario.name)}`);
    lines.push(`- **GIVEN** ${scenario.given ?? 'the system is in a valid state'}`);
    lines.push(`- **WHEN** ${scenario.when ?? 'the operation is invoked'}`);
    lines.push(`- **THEN** ${scenario.then ?? 'the expected outcome occurs'}`);
    if (scenario.and && scenario.and.length > 0) {
      const andClauses = Array.isArray(scenario.and) ? scenario.and : [scenario.and];
      for (const andClause of andClauses) {
        lines.push(`- **AND** ${andClause}`);
      }
    }
    lines.push('');
  }

  /**
   * Format a requirement name (PascalCase, no spaces)
   */
  private formatRequirementName(name: string | undefined): string {
    if (!name) return 'Unnamed';
    return name
      .split(/[\s_-]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }

  /**
   * Format a relationship for display
   */
  private formatRelationship(rel: { targetEntity: string; type: string; description?: string }): string {
    const typeLabel = {
      'one-to-one': 'has one',
      'one-to-many': 'has many',
      'many-to-many': 'has many',
      'belongs-to': 'belongs to',
    }[rel.type] || rel.type;

    return `${typeLabel} ${rel.targetEntity}${rel.description ? ` (${rel.description})` : ''}`;
  }

  /**
   * Format project category for display
   */
  private formatCategory(category: string): string {
    const labels: Record<string, string> = {
      'web-frontend': 'Web Frontend Application',
      'web-backend': 'Web Backend Service',
      'api-service': 'API Service',
      'cli-tool': 'Command Line Tool',
      library: 'Library/Package',
      'mobile-app': 'Mobile Application',
      'desktop-app': 'Desktop Application',
      'data-pipeline': 'Data Pipeline',
      'ml-service': 'Machine Learning Service',
      monorepo: 'Monorepo',
      other: 'Other',
    };
    return labels[category] || category;
  }

  /**
   * Format architecture pattern for display
   */
  private formatArchitecture(pattern: string): string {
    const labels: Record<string, string> = {
      layered: 'Layered Architecture',
      hexagonal: 'Hexagonal Architecture (Ports & Adapters)',
      microservices: 'Microservices',
      monolith: 'Monolithic',
      serverless: 'Serverless',
      'event-driven': 'Event-Driven Architecture',
      mvc: 'Model-View-Controller (MVC)',
      other: 'Custom Architecture',
    };
    return labels[pattern] || pattern;
  }

  /**
   * Capitalize first letter
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Wrap text at max line width
   */
  private wrapText(text: unknown): string {
    if (!text) return '';
    const str = typeof text === 'string' ? text : JSON.stringify(text);

    const words = str.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 > this.options.maxLineWidth) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = currentLine ? `${currentLine} ${word}` : word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.join('\n');
  }
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a generated spec against OpenSpec conventions
 */
export function validateSpec(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for title
  if (!content.match(/^#\s+.+/m)) {
    errors.push('Missing title (# heading)');
  }

  // Check for Purpose section
  if (!content.includes('## Purpose')) {
    warnings.push('Missing Purpose section');
  }

  // Check for Requirements section (except overview)
  if (!content.includes('## Requirements') && !content.includes('## Domains')) {
    warnings.push('Missing Requirements section');
  }

  // Check requirement format (RFC 2119 keywords)
  const requirements = content.match(/###\s+Requirement:\s+.+/g) || [];
  for (const req of requirements) {
    const reqSection = content.substring(content.indexOf(req));
    const nextSection = reqSection.indexOf('\n### ');
    const reqContent = nextSection > 0 ? reqSection.substring(0, nextSection) : reqSection;

    if (!reqContent.match(/\b(SHALL|MUST|SHOULD|MAY)\b/)) {
      warnings.push(`Requirement missing RFC 2119 keyword: ${req}`);
    }
  }

  // Check scenario format
  const scenarios = content.match(/####\s+Scenario:\s+.+/g) || [];
  for (const scenario of scenarios) {
    const scenarioSection = content.substring(content.indexOf(scenario));
    const nextScenario = scenarioSection.indexOf('\n#### ');
    const scenarioContent = nextScenario > 0 ? scenarioSection.substring(0, nextScenario) : scenarioSection;

    if (!scenarioContent.includes('**GIVEN**')) {
      errors.push(`Scenario missing GIVEN: ${scenario}`);
    }
    if (!scenarioContent.includes('**WHEN**')) {
      errors.push(`Scenario missing WHEN: ${scenario}`);
    }
    if (!scenarioContent.includes('**THEN**')) {
      errors.push(`Scenario missing THEN: ${scenario}`);
    }
  }

  // Check for delta markers (should not be in generated specs)
  if (content.match(/\[ADDED\]|\[MODIFIED\]|\[REMOVED\]/)) {
    errors.push('Generated specs should not contain delta markers');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Generate OpenSpec files from pipeline result
 */
export function generateOpenSpecs(
  result: PipelineResult,
  options?: GeneratorOptions
): GeneratedSpec[] {
  const generator = new OpenSpecFormatGenerator(options);
  return generator.generateSpecs(result);
}
