'use client';

import { Activity, BellDot, Boxes, Map as MapIcon, MapPin, Radio, Waypoints } from 'lucide-react';
import Image, { type StaticImageData } from 'next/image';
import { useState } from 'react';
import dashboardPreview from './painel.webp';
import alertsPreview from './painel-alertas.webp';
import mapPreview from './painel-mapa.webp';
import networkPreview from './painel-rede.webp';
import topologyPreview from './painel-topologia.webp';
import styles from '../site.module.css';

type PreviewTopic = { label: string; icon: typeof Boxes; title: string; description: string; image?: StaticImageData; alt?: string };

const overviewAlt = 'Visão geral do painel Malha no tema escuro: parque tecnológico com 8 ativos em 3 fazendas, coletores em contato, críticos offline, ocorrências abertas, cobertura UniFi e a lista de ocorrências abertas';

const topics = {
  assets: {
    label: 'Parque',
    icon: Boxes,
    title: 'Veja o parque tecnológico inteiro',
    description: 'Todos os ativos das fazendas em uma barra só: em contato, offline, indeterminado e sem telemetria. Ao lado, coletores, críticos offline, ocorrências abertas e cobertura UniFi.',
  },
  units: {
    label: 'Unidades',
    icon: MapPin,
    title: 'Filtre por fazenda',
    description: 'Escolha uma unidade em "Todas as fazendas" para ver só os ativos, coletores e ocorrências dela. Sem filtro, a visão geral soma todas as fazendas do grupo.',
  },
  collectors: {
    label: 'Coletores',
    icon: Radio,
    title: 'Saiba quem está falando com a matriz',
    description: 'Quantos coletores estão em contato e quantas fazendas estão sem coletor. Se um coletor fica 3 minutos sem sinal, abre uma ocorrência.',
  },
  topology: {
    label: 'Topologia',
    icon: Waypoints,
    title: 'Veja como a rede de cada fazenda se liga',
    description: 'Gateway, switches e pontos de acesso em hierarquia, a partir do uplink de cada equipamento. Porta a porta só quando as duas pontas são conhecidas; destaque uma VLAN para ver por onde ela passa.',
    image: topologyPreview,
    alt: 'Aba Topologia: hierarquia da Fazenda Campo Bom com gateway, switch central, switch do secador e pontos de acesso, com as portas de cada ligação',
  },
  map: {
    label: 'Mapa',
    icon: MapIcon,
    title: 'Todas as fazendas no mapa',
    description: 'Cor e anel mostram a saúde de cada fazenda; o mapa de calor mostra tráfego, ativos offline, ocorrências ou dados enviados pelo coletor, de 24 horas a 30 dias. Ao lado, a soma por estado e região.',
    image: mapPreview,
    alt: 'Aba Mapa: fazendas posicionadas no mapa com a cor da saúde, mapa de calor do tráfego e legenda',
  },
  network: {
    label: 'Rede',
    icon: Activity,
    title: 'Tráfego, portas e VLANs',
    description: 'Portas ativas, utilização, PoE e VLANs; tráfego recebido e enviado ao longo do dia, por fazenda e por dispositivo, e a utilização de cada porta dos switches. Tudo com tabela alternativa.',
    image: networkPreview,
    alt: 'Painel de rede: indicadores de portas ativas, utilização, erros, PoE, VLANs e dispositivos offline, e o gráfico de tráfego recebido e enviado nas últimas 24 horas',
  },
  alerts: {
    label: 'Alertas',
    icon: BellDot,
    title: 'Avisos no Telegram e no e-mail',
    description: 'Cadastre um bot do Telegram ou uma lista de e-mails por grupo, filtrando por fazenda, tipo e severidade. Mensagem de teste, novas tentativas em falhas temporárias e histórico de cada entrega.',
    image: alertsPreview,
    alt: 'Aba Alertas: cadastro de canal do Telegram com severidade mínima, limite de mensagens, fazendas e tipos de ocorrência',
  },
} satisfies Record<string, PreviewTopic>;

type Topic = keyof typeof topics;

export function DashboardPreview() {
  const [selected, setSelected] = useState<Topic>('assets');
  const topic: PreviewTopic = topics[selected];

  return (
    <figure className={styles.panelFigure}>
      <figcaption className={styles.panelCaption}>
        <span><Radio size={16} aria-hidden="true" /> {topic.image ? `Painel · ${topic.label}` : 'Visão geral das fazendas'}</span>
        <span>Dados de demonstração</span>
      </figcaption>
      <div className={styles.previewImageWrap}>
        <Image className={styles.panelImage} src={topic.image ?? dashboardPreview} alt={topic.alt ?? overviewAlt} sizes="(max-width: 48rem) 94vw, 76rem" data-shot={topic.image ? 'tab' : undefined} unoptimized />
        {!topic.image && <div aria-hidden="true" className={styles.previewHighlight} data-topic={selected} />}
      </div>
      <div className={styles.previewExplorer}>
        <div className={styles.previewControls} role="group" aria-label="Explorar o painel de demonstração">
          {(Object.keys(topics) as Topic[]).map((key) => {
            const { icon: Icon, label } = topics[key];
            return (
              <button
                key={key}
                type="button"
                aria-controls="malha-preview-detail"
                aria-pressed={selected === key}
                onClick={() => setSelected(key)}
              >
                <Icon size={17} aria-hidden="true" /> {label}
              </button>
            );
          })}
        </div>
        <div id="malha-preview-detail" className={styles.previewDetail} aria-live="polite" aria-atomic="true">
          <div key={selected} className={styles.previewDetailBody}>
            <h3>{topic.title}</h3>
            <p>{topic.description}</p>
          </div>
        </div>
      </div>
    </figure>
  );
}
